import { DatabaseSync } from "node:sqlite";

const MAPPING_HEADERS = ["账户", "账户id", "推广目的", "联盟分类", "报表分类", "设备"];

export class MappingStore {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS account_mappings (
        account_id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        alliance TEXT NOT NULL DEFAULT '',
        report_class TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '',
        remark TEXT NOT NULL DEFAULT '',
        account_tag TEXT NOT NULL DEFAULT '',
        source_file TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mapping_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        total_rows INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        updated_count INTEGER NOT NULL,
        unchanged_count INTEGER NOT NULL,
        deleted_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mapping_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        change_type TEXT NOT NULL,
        previous_value TEXT,
        next_value TEXT NOT NULL
      );
    `);
    ensureColumn(this.database, "mapping_imports", "deleted_count", "INTEGER NOT NULL DEFAULT 0");
  }

  getStatus() {
    const count = Number(this.database.prepare("SELECT COUNT(*) AS count FROM account_mappings").get().count);
    const lastImport = this.database.prepare(`
      SELECT filename, imported_at AS importedAt, total_rows AS totalRows,
             inserted_count AS inserted, updated_count AS updated,
             unchanged_count AS unchanged, deleted_count AS deleted
      FROM mapping_imports ORDER BY id DESC LIMIT 1
    `).get() ?? null;
    return { initialized: count > 0, count, lastImport, options: this.getOptions() };
  }

  asWorkbookSource() {
    const rows = this.database.prepare(`
      SELECT account_name, account_id, purpose, alliance, report_class, device, remark, account_tag
      FROM account_mappings ORDER BY CAST(account_id AS INTEGER), account_id
    `).all().map(toWorkbookRow);
    return { sheetName: "账户分类库", headers: [...MAPPING_HEADERS, "备注", "账户标签"], rows };
  }

  previewImport(source, filename) {
    const normalized = normalizeImportSource(source);
    const currentRows = this.database.prepare("SELECT * FROM account_mappings").all();
    const currentById = new Map(currentRows.map((row) => [row.account_id, row]));
    const nextById = new Map(normalized.map((row) => [row.accountId, row]));
    const inserted = normalized.filter((row) => !currentById.has(row.accountId));
    const updated = normalized.filter((row) => currentById.has(row.accountId) && !sameMapping(currentById.get(row.accountId), row));
    const unchanged = normalized.filter((row) => currentById.has(row.accountId) && sameMapping(currentById.get(row.accountId), row));
    const deleted = currentRows.filter((row) => !nextById.has(row.account_id));
    return {
      filename,
      currentCount: currentRows.length,
      finalCount: normalized.length,
      inserted: inserted.length,
      updated: updated.length,
      unchanged: unchanged.length,
      deleted: deleted.length,
      insertedSample: inserted.slice(0, 12).map(mappingSummary),
      updatedSample: updated.slice(0, 12).map(mappingSummary),
      deletedSample: deleted.slice(0, 12).map((row) => mappingSummary(databaseRow(row))),
    };
  }

  importWorkbook(source, filename) {
    const normalized = normalizeImportSource(source);

    const select = this.database.prepare("SELECT * FROM account_mappings WHERE account_id = ?");
    const insert = this.database.prepare(`
      INSERT INTO account_mappings (
        account_id, account_name, purpose, alliance, report_class, device,
        remark, account_tag, source_file, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = this.database.prepare(`
      UPDATE account_mappings SET account_name = ?, purpose = ?, alliance = ?, report_class = ?,
        device = ?, remark = ?, account_tag = ?, source_file = ?, updated_at = ?
      WHERE account_id = ?
    `);
    const logChange = this.database.prepare(`
      INSERT INTO mapping_changes (account_id, changed_at, change_type, previous_value, next_value)
      VALUES (?, ?, ?, ?, ?)
    `);
    const deleteMapping = this.database.prepare("DELETE FROM account_mappings WHERE account_id = ?");
    const timestamp = new Date().toISOString();
    const counts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
    const nextIds = new Set(normalized.map((row) => row.accountId));

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of normalized) {
        const previous = select.get(row.accountId);
        if (!previous) {
          insert.run(row.accountId, row.accountName, row.purpose, row.alliance, row.reportClass, row.device, row.remark, row.accountTag, filename, timestamp, timestamp);
          logChange.run(row.accountId, timestamp, "import-insert", null, JSON.stringify(row));
          counts.inserted += 1;
          continue;
        }
        if (sameMapping(previous, row)) {
          counts.unchanged += 1;
          continue;
        }
        update.run(row.accountName, row.purpose, row.alliance, row.reportClass, row.device, row.remark, row.accountTag, filename, timestamp, row.accountId);
        logChange.run(row.accountId, timestamp, "import-update", JSON.stringify(databaseRow(previous)), JSON.stringify(row));
        counts.updated += 1;
      }
      const removedRows = this.database.prepare("SELECT * FROM account_mappings").all().filter((row) => !nextIds.has(row.account_id));
      for (const row of removedRows) {
        deleteMapping.run(row.account_id);
        logChange.run(row.account_id, timestamp, "import-delete", JSON.stringify(databaseRow(row)), JSON.stringify({ accountId: row.account_id, deletedBy: filename }));
        counts.deleted += 1;
      }
      this.database.prepare(`
        INSERT INTO mapping_imports (filename, imported_at, total_rows, inserted_count, updated_count, unchanged_count, deleted_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(filename, timestamp, normalized.length, counts.inserted, counts.updated, counts.unchanged, counts.deleted);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { filename, totalRows: normalized.length, ...counts, status: this.getStatus() };
  }

  saveMappings(items) {
    if (!Array.isArray(items) || !items.length) throw new Error("没有需要保存的账户分类。");
    const normalized = items.map(normalizeManualMapping);
    const duplicateIds = findDuplicateIds(normalized.map((row) => row.accountId));
    if (duplicateIds.length) throw new Error("待保存账户中存在重复账户ID。");

    const select = this.database.prepare("SELECT * FROM account_mappings WHERE account_id = ?");
    const insert = this.database.prepare(`
      INSERT INTO account_mappings (
        account_id, account_name, purpose, alliance, report_class, device,
        remark, account_tag, source_file, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', '', '网页补充', ?, ?)
    `);
    const update = this.database.prepare(`
      UPDATE account_mappings SET account_name = ?, purpose = ?, alliance = ?, report_class = ?,
        device = ?, source_file = '网页补充', updated_at = ? WHERE account_id = ?
    `);
    const logChange = this.database.prepare(`
      INSERT INTO mapping_changes (account_id, changed_at, change_type, previous_value, next_value)
      VALUES (?, ?, ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of normalized) {
        const previous = select.get(row.accountId);
        if (previous) {
          update.run(row.accountName, row.purpose, row.alliance, row.reportClass, row.device, timestamp, row.accountId);
          logChange.run(row.accountId, timestamp, "manual-update", JSON.stringify(databaseRow(previous)), JSON.stringify(row));
        } else {
          insert.run(row.accountId, row.accountName, row.purpose, row.alliance, row.reportClass, row.device, timestamp, timestamp);
          logChange.run(row.accountId, timestamp, "manual-insert", null, JSON.stringify(row));
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { saved: normalized.length, status: this.getStatus() };
  }

  getOptions() {
    const distinct = (column) => this.database.prepare(`SELECT DISTINCT ${column} AS value FROM account_mappings WHERE ${column} <> '' ORDER BY ${column}`).all().map((row) => row.value);
    return {
      purposes: distinct("purpose"),
      alliances: distinct("alliance"),
      reportClasses: distinct("report_class"),
      devices: distinct("device"),
    };
  }

  close() {
    this.database.close();
  }
}

function validateWorkbook(source) {
  const missing = MAPPING_HEADERS.filter((header) => !source.headers.includes(header));
  if (missing.length) throw new Error(`匹配表缺少表头：${missing.join("、")}`);
  const missingIds = source.rows.filter((row) => !normalizeId(row["账户id"]));
  if (missingIds.length) throw new Error(`匹配表包含${missingIds.length}行空账户ID。`);
}

function normalizeImportSource(source) {
  validateWorkbook(source);
  const normalized = source.rows.map(normalizeWorkbookRow);
  const duplicateIds = findDuplicateIds(normalized.map((row) => row.accountId));
  if (duplicateIds.length) throw new Error(`匹配表包含${duplicateIds.length}个重复账户ID，请处理后重新导入。`);
  return normalized;
}

function normalizeWorkbookRow(row) {
  return {
    accountId: normalizeId(row["账户id"]),
    accountName: clean(row["账户"]),
    purpose: clean(row["推广目的"]),
    alliance: clean(row["联盟分类"]),
    reportClass: clean(row["报表分类"]),
    device: clean(row["设备"]),
    remark: clean(row["备注"]),
    accountTag: clean(row["账户标签"]),
  };
}

function normalizeManualMapping(row) {
  const normalized = {
    accountId: normalizeId(row.accountId),
    accountName: clean(row.accountName),
    purpose: clean(row.purpose),
    alliance: clean(row.alliance),
    reportClass: clean(row.reportClass),
    device: clean(row.device),
  };
  const missing = Object.entries(normalized).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`账户${normalized.accountId || "（无ID）"}的分类信息不完整。`);
  return normalized;
}

function toWorkbookRow(row) {
  return {
    "账户": row.account_name,
    "账户id": row.account_id,
    "推广目的": row.purpose,
    "联盟分类": row.alliance,
    "报表分类": row.report_class,
    "设备": row.device,
    "备注": row.remark,
    "账户标签": row.account_tag,
  };
}

function sameMapping(previous, next) {
  return previous.account_name === next.accountName && previous.purpose === next.purpose &&
    previous.alliance === next.alliance && previous.report_class === next.reportClass &&
    previous.device === next.device && previous.remark === next.remark && previous.account_tag === next.accountTag;
}

function databaseRow(row) {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    purpose: row.purpose,
    alliance: row.alliance,
    reportClass: row.report_class,
    device: row.device,
    remark: row.remark,
    accountTag: row.account_tag,
  };
}

function mappingSummary(row) {
  return { accountId: row.accountId, accountName: row.accountName, purpose: row.purpose, alliance: row.alliance, reportClass: row.reportClass, device: row.device };
}

function ensureColumn(database, table, column, definition) {
  const existing = database.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (!existing) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function findDuplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function normalizeId(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/\.0$/, "");
}

function clean(value) {
  return String(value ?? "").trim();
}
