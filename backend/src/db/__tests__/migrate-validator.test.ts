import { describe, it, expect } from 'vitest'
import {
  isValidMigrationFilename,
  validateNoTransactionStatements,
} from '../migrate.js'

describe('isValidMigrationFilename', () => {
  it('accepts NNN_lowercase_snake.sql', () => {
    expect(isValidMigrationFilename('001_smoke.sql')).toBe(true)
    expect(isValidMigrationFilename('042_create_users_table.sql')).toBe(true)
  })

  it('rejects uppercase, spaces, unicode, missing prefix', () => {
    expect(isValidMigrationFilename('001_Smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('001 smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('001_première.sql')).toBe(false)
    expect(isValidMigrationFilename('smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('1_x.sql')).toBe(false) // need 3+ digits
    expect(isValidMigrationFilename('001_smoke.SQL')).toBe(false)
    expect(isValidMigrationFilename('.001_smoke.sql')).toBe(false)
  })
})

describe('validateNoTransactionStatements', () => {
  it('accepts a normal CREATE TABLE statement', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', 'CREATE TABLE x (id INT);')
    }).not.toThrow()
  })

  it('accepts a DO block containing BEGIN/END', () => {
    const sql = `DO $$ BEGIN RAISE NOTICE 'hi'; END $$;`
    expect(() => {
      validateNoTransactionStatements('a.sql', sql)
    }).not.toThrow()
  })

  it('accepts a CREATE FUNCTION with BEGIN/END body', () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'hi';
END
$$ LANGUAGE plpgsql;`
    expect(() => {
      validateNoTransactionStatements('a.sql', sql)
    }).not.toThrow()
  })

  it('accepts a tagged dollar-quoted block', () => {
    const sql = `CREATE FUNCTION g() RETURNS void AS $body$
BEGIN
  PERFORM 1;
END
$body$ LANGUAGE plpgsql;`
    expect(() => {
      validateNoTransactionStatements('a.sql', sql)
    }).not.toThrow()
  })

  it('rejects a top-level COMMIT;', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', 'CREATE TABLE x (id INT);\nCOMMIT;')
    }).toThrow(/forbidden top-level transaction statement.*COMMIT/i)
  })

  it('rejects a top-level BEGIN;', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', 'BEGIN;\nCREATE TABLE x (id INT);')
    }).toThrow(/forbidden top-level transaction statement.*BEGIN/i)
  })

  it('rejects ROLLBACK on its own line', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', '  rollback ; ')
    }).toThrow(/forbidden top-level transaction statement.*ROLLBACK/i)
  })

  it('rejects START TRANSACTION', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', 'START TRANSACTION;')
    }).toThrow(/forbidden top-level transaction statement/i)
  })

  it('ignores BEGIN inside a single-line --comment', () => {
    expect(() => {
      validateNoTransactionStatements('a.sql', '-- BEGIN;\nCREATE TABLE x (id INT);')
    }).not.toThrow()
  })

  it('error message includes filename and line number', () => {
    try {
      validateNoTransactionStatements('999_bad.sql', '\n\nCOMMIT;\n')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as Error).message).toContain('999_bad.sql')
      expect((err as Error).message).toContain('line 3')
    }
  })
})
