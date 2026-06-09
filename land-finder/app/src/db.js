import mysql from 'mysql2/promise';
import { MYSQL_URL } from './config.js';


async function addColumnIfMissing(conn, table, column, ddl) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!rows.length) await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

async function addIndexIfMissing(conn, table, index, column) {
  const [rows] = await conn.query(`SHOW INDEX FROM ${table} WHERE Key_name=?`, [index]);
  if (!rows.length) await conn.query(`ALTER TABLE ${table} ADD INDEX ${index} (${column})`);
}

export async function pool() {
  return mysql.createPool(MYSQL_URL + (MYSQL_URL.includes('?') ? '&' : '?') + 'charset=utf8mb4');
}

export async function ensureSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id BIGINT PRIMARY KEY,
      source_site VARCHAR(32) NOT NULL DEFAULT '591',
      source_id VARCHAR(64) NULL,
      source_key VARCHAR(128) NULL,
      houseid VARCHAR(32) NOT NULL,
      region_id INT NOT NULL,
      region_name VARCHAR(32) NOT NULL,
      property_type VARCHAR(16) NOT NULL DEFAULT 'land',
      sale_kind VARCHAR(16) NULL,
      title VARCHAR(512),
      price_wan DECIMAL(12,2),
      area_ping DECIMAL(12,2),
      unit_price VARCHAR(64),
      layout_text VARCHAR(64) NULL,
      bedroom_count INT NULL,
      community_name VARCHAR(128) NULL,
      floor_text VARCHAR(64) NULL,
      parking_text VARCHAR(128) NULL,
      house_age VARCHAR(64) NULL,
      house_age_year DECIMAL(6,1) NULL,
      address VARCHAR(255),
      section_name VARCHAR(64),
      segment_name VARCHAR(128),
      road_text VARCHAR(128),
      road_width_m DECIMAL(8,2) NULL,
      ground_type VARCHAR(32),
      price_reduction_wan DECIMAL(12,2) NULL,
      browsenum_all INT NULL,
      has_video TINYINT(1) NULL,
      is_below_stand TINYINT(1) NULL,
      is_high_value TINYINT(1) NULL,
      zoning VARCHAR(255),
      land_category VARCHAR(128),
      ownership VARCHAR(64),
      land_number VARCHAR(128),
      frontage_depth VARCHAR(128),
      infrastructure VARCHAR(255),
      disliked_facilities VARCHAR(255),
      detail_description TEXT,
      detail_json JSON,
      detail_error TEXT NULL,
      detail_fetched_at DATETIME NULL,
      listing_status VARCHAR(32) NOT NULL DEFAULT 'active',
      unavailable_at DATETIME NULL,
      tags JSON,
      photo_url TEXT,
      url TEXT,
      raw JSON,
      lvr_match_level VARCHAR(32) NULL,
      lvr_sample_count INT NULL,
      lvr_median_unit_wan DECIMAL(12,4) NULL,
      lvr_recent_years VARCHAR(32) NULL,
      lvr_basis_json JSON NULL,
      lvr_updated_at DATETIME NULL,
      user_score DECIMAL(6,1) NOT NULL DEFAULT 0,
      user_note TEXT NULL,
      is_favorite TINYINT(1) NOT NULL DEFAULT 0,
      user_edited_at DATETIME NULL,
      cp_score DECIMAL(5,1) NULL,
      cp_note TEXT NULL,
      cp_updated_at DATETIME NULL,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_filter (price_wan, area_ping, region_id),
      KEY idx_property_type (property_type),
      KEY idx_region (region_id),
      KEY idx_cp_score (cp_score)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await addColumnIfMissing(conn, 'properties', 'source_site', "VARCHAR(32) NOT NULL DEFAULT '591'");
  await addColumnIfMissing(conn, 'properties', 'source_id', 'VARCHAR(64) NULL');
  await addColumnIfMissing(conn, 'properties', 'source_key', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'property_type', "VARCHAR(16) NOT NULL DEFAULT 'land'");
  await addColumnIfMissing(conn, 'properties', 'sale_kind', 'VARCHAR(16) NULL');
  await addColumnIfMissing(conn, 'properties', 'layout_text', 'VARCHAR(64) NULL');
  await addColumnIfMissing(conn, 'properties', 'bedroom_count', 'INT NULL');
  await addColumnIfMissing(conn, 'properties', 'community_name', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'floor_text', 'VARCHAR(64) NULL');
  await addColumnIfMissing(conn, 'properties', 'parking_text', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'house_age', 'VARCHAR(64) NULL');
  await addColumnIfMissing(conn, 'properties', 'house_age_year', 'DECIMAL(6,1) NULL');
  await addColumnIfMissing(conn, 'properties', 'segment_name', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'road_width_m', 'DECIMAL(8,2) NULL');
  await addColumnIfMissing(conn, 'properties', 'ground_type', 'VARCHAR(32) NULL');
  await addColumnIfMissing(conn, 'properties', 'price_reduction_wan', 'DECIMAL(12,2) NULL');
  await addColumnIfMissing(conn, 'properties', 'browsenum_all', 'INT NULL');
  await addColumnIfMissing(conn, 'properties', 'has_video', 'TINYINT(1) NULL');
  await addColumnIfMissing(conn, 'properties', 'is_below_stand', 'TINYINT(1) NULL');
  await addColumnIfMissing(conn, 'properties', 'is_high_value', 'TINYINT(1) NULL');
  await addColumnIfMissing(conn, 'properties', 'zoning', 'VARCHAR(255) NULL');
  await addColumnIfMissing(conn, 'properties', 'land_category', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'ownership', 'VARCHAR(64) NULL');
  await addColumnIfMissing(conn, 'properties', 'land_number', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'frontage_depth', 'VARCHAR(128) NULL');
  await addColumnIfMissing(conn, 'properties', 'infrastructure', 'VARCHAR(255) NULL');
  await addColumnIfMissing(conn, 'properties', 'disliked_facilities', 'VARCHAR(255) NULL');
  await addColumnIfMissing(conn, 'properties', 'detail_description', 'TEXT NULL');
  await addColumnIfMissing(conn, 'properties', 'detail_json', 'JSON NULL');
  await addColumnIfMissing(conn, 'properties', 'detail_error', 'TEXT NULL');
  await addColumnIfMissing(conn, 'properties', 'detail_fetched_at', 'DATETIME NULL');
  await addColumnIfMissing(conn, 'properties', 'listing_status', "VARCHAR(32) NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(conn, 'properties', 'unavailable_at', 'DATETIME NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_match_level', 'VARCHAR(32) NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_sample_count', 'INT NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_median_unit_wan', 'DECIMAL(12,4) NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_recent_years', 'VARCHAR(32) NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_basis_json', 'JSON NULL');
  await addColumnIfMissing(conn, 'properties', 'lvr_updated_at', 'DATETIME NULL');
  await addColumnIfMissing(conn, 'properties', 'user_score', 'DECIMAL(6,1) NOT NULL DEFAULT 0');
  await addColumnIfMissing(conn, 'properties', 'user_note', 'TEXT NULL');
  await addColumnIfMissing(conn, 'properties', 'is_favorite', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing(conn, 'properties', 'user_edited_at', 'DATETIME NULL');
  await addColumnIfMissing(conn, 'properties', 'cp_score', 'DECIMAL(5,1) NULL');
  await addColumnIfMissing(conn, 'properties', 'cp_note', 'TEXT NULL');
  await addColumnIfMissing(conn, 'properties', 'cp_updated_at', 'DATETIME NULL');
  await addIndexIfMissing(conn, 'properties', 'idx_property_type', 'property_type');
  await addIndexIfMissing(conn, 'properties', 'idx_source_site', 'source_site');
  await addIndexIfMissing(conn, 'properties', 'idx_source_key', 'source_key');
  await addIndexIfMissing(conn, 'properties', 'idx_cp_score', 'cp_score');
  await addIndexIfMissing(conn, 'properties', 'idx_lvr_match', 'lvr_sample_count');
  await addIndexIfMissing(conn, 'properties', 'idx_listing_status', 'listing_status');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS lvr_land_transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_season VARCHAR(16) NOT NULL,
      county_code VARCHAR(4) NOT NULL,
      region_id INT NULL,
      region_name VARCHAR(32) NOT NULL,
      section_name VARCHAR(64) NOT NULL,
      segment_name VARCHAR(128) NULL,
      land_position VARCHAR(255) NULL,
      transaction_target VARCHAR(64) NULL,
      transaction_date_raw VARCHAR(16) NULL,
      transaction_year INT NULL,
      area_sqm DECIMAL(14,2) NULL,
      area_ping DECIMAL(14,2) NULL,
      total_price_ntd BIGINT NULL,
      unit_price_sqm DECIMAL(14,2) NULL,
      unit_price_wan_ping DECIMAL(12,4) NULL,
      urban_zoning VARCHAR(128) NULL,
      non_urban_zone VARCHAR(128) NULL,
      non_urban_use VARCHAR(128) NULL,
      land_use VARCHAR(255) NULL,
      transfer_status VARCHAR(64) NULL,
      note TEXT NULL,
      serial_no VARCHAR(64) NOT NULL,
      raw JSON NULL,
      imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_lvr (source_season, serial_no, land_position, area_sqm, total_price_ntd),
      KEY idx_lvr_region (region_id, section_name, segment_name),
      KEY idx_lvr_type (non_urban_use, urban_zoning),
      KEY idx_lvr_unit (unit_price_wan_ping),
      KEY idx_lvr_year (transaction_year)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS lvr_house_transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_season VARCHAR(16) NOT NULL,
      county_code VARCHAR(4) NOT NULL,
      region_id INT NULL,
      region_name VARCHAR(32) NOT NULL,
      section_name VARCHAR(64) NOT NULL,
      address VARCHAR(255) NULL,
      transaction_target VARCHAR(64) NULL,
      transaction_date_raw VARCHAR(16) NULL,
      transaction_year INT NULL,
      building_area_sqm DECIMAL(14,2) NULL,
      building_area_ping DECIMAL(14,2) NULL,
      total_price_ntd BIGINT NULL,
      unit_price_wan_ping DECIMAL(12,4) NULL,
      building_type VARCHAR(128) NULL,
      layout_text VARCHAR(64) NULL,
      parking_text VARCHAR(128) NULL,
      note TEXT NULL,
      serial_no VARCHAR(64) NOT NULL,
      raw JSON NULL,
      imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_lvr_house (source_season, serial_no, address, building_area_sqm, total_price_ntd),
      KEY idx_lvr_house_region (region_id, section_name),
      KEY idx_lvr_house_unit (unit_price_wan_ping),
      KEY idx_lvr_house_year (transaction_year)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      message TEXT,
      fetched_count INT NOT NULL DEFAULT 0,
      matched_count INT NOT NULL DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value JSON NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      criteria JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_updated_at (updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      run_id BIGINT NULL,
      property_id BIGINT NOT NULL,
      event_type VARCHAR(32) NOT NULL DEFAULT 'new_listing',
      title VARCHAR(512) NULL,
      message TEXT NULL,
      channel VARCHAR(64) NOT NULL DEFAULT 'local-ui',
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      read_at DATETIME NULL,
      sent_at DATETIME NULL,
      error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_notification_event (event_type, property_id),
      KEY idx_notification_created (created_at),
      KEY idx_notification_read (read_at),
      KEY idx_notification_run (run_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}
