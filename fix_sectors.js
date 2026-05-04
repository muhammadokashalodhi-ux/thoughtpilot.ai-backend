require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  try {
    console.log('Fixing sectors column...');

    // Step 1: Add a temporary JSONB column
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sectors_new JSONB DEFAULT '[]'`);
    console.log('✅ Added sectors_new column');

    // Step 2: Copy data converting TEXT[] to JSONB
    await pool.query(`
      UPDATE profiles 
      SET sectors_new = to_json(sectors)::jsonb
      WHERE sectors IS NOT NULL
    `);
    console.log('✅ Copied sectors data');

    // Step 3: Drop old column
    await pool.query(`ALTER TABLE profiles DROP COLUMN sectors`);
    console.log('✅ Dropped old sectors column');

    // Step 4: Rename new column
    await pool.query(`ALTER TABLE profiles RENAME COLUMN sectors_new TO sectors`);
    console.log('✅ Renamed sectors_new to sectors');

    // Fix content_pillars too
    await pool.query(`
      ALTER TABLE profiles 
      ALTER COLUMN content_pillars TYPE JSONB 
      USING content_pillars::text::jsonb
    `);
    console.log('✅ content_pillars fixed');

    console.log('\n✅ All done!');
  } catch (err) {
    console.log('Error:', err.message);
  } finally {
    await pool.end();
  }
}

fix();