#!/usr/bin/env node

/**
 * Pombo Relay - Admin CLI Tool
 * ============================================
 * Command-line interface for managing the relay server
 * 
 * Usage:
 *   node admin-cli.js list              - List all registrations
 *   node admin-cli.js list <tag>        - List registrations for a specific tag
 *   node admin-cli.js stats             - Show statistics
 *   node admin-cli.js clean-expired     - Remove expired tokens
 *   node admin-cli.js delete <tag>      - Delete all tokens for a tag
 *   node admin-cli.js delete <tag> <token> - Delete specific token
 *   node admin-cli.js export            - Export DB to JSON
 *   node admin-cli.js import <file>     - Import tokens from JSON
 *   node admin-cli.js events <limit>    - Show recent events (default: 50)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'tokens.db');

// Verify DB exists
if (!fs.existsSync(dbPath)) {
    console.error('❌ Database not found at:', dbPath);
    console.error('Start the relay server first with: npm start');
    process.exit(1);
}

const db = new Database(dbPath);

// Get command from arguments
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

function printHeader(title) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ${title}`);
    console.log('═══════════════════════════════════════════════════════════');
}

function printRow(label, value) {
    console.log(`  ${label.padEnd(20)} ${value}`);
}

// ============================================
// COMMAND: list
// ============================================
function cmdList(tag) {
    printHeader('📋 REGISTRATIONS');
    
    let query;
    let params = [];
    
    if (tag) {
        query = 'SELECT id, tag, push_token, created_at, updated_at FROM registrations WHERE tag = ? ORDER BY created_at DESC';
        params = [tag];
    } else {
        query = 'SELECT id, tag, push_token, created_at, updated_at FROM registrations ORDER BY tag, created_at DESC';
    }
    
    const registrations = db.prepare(query).all(...params);
    
    if (registrations.length === 0) {
        console.log('  No registrations found');
        printFooter();
        return;
    }
    
    // Group by tag if showing all
    if (!tag) {
        const grouped = {};
        registrations.forEach(reg => {
            if (!grouped[reg.tag]) grouped[reg.tag] = [];
            grouped[reg.tag].push(reg);
        });
        
        Object.entries(grouped).forEach(([tagName, regs]) => {
            console.log(`\n  📌 Tag: ${tagName} (${regs.length} device${regs.length !== 1 ? 's' : ''})`);
            regs.forEach((reg, idx) => {
                const tokenPreview = reg.push_token.slice(0, 80) + (reg.push_token.length > 80 ? '...' : '');
                console.log(`     [${idx + 1}] ${tokenPreview}`);
                console.log(`         Created: ${new Date(reg.created_at * 1000).toISOString()}`);
            });
        });
    } else {
        registrations.forEach((reg, idx) => {
            const tokenPreview = reg.push_token.slice(0, 80) + (reg.push_token.length > 80 ? '...' : '');
            console.log(`  [${idx + 1}] ${tokenPreview}`);
            console.log(`      Created: ${new Date(reg.created_at * 1000).toISOString()}`);
            console.log(`      Updated: ${new Date(reg.updated_at * 1000).toISOString()}`);
        });
    }
    
    printFooter();
}

// ============================================
// COMMAND: stats
// ============================================
function cmdStats() {
    printHeader('📊 STATISTICS');
    
    // Overall stats
    const totalRegs = db.prepare('SELECT COUNT(*) as count FROM registrations').get();
    const totalEvents = db.prepare('SELECT COUNT(*) as count FROM stats').get();
    
    // Today's stats
    const todayPushes = db.prepare(`
        SELECT COUNT(*) as count FROM stats 
        WHERE event = 'push_sent' 
        AND created_at > strftime('%s', 'now', '-1 day')
    `).get();
    
    const todayRegistrations = db.prepare(`
        SELECT COUNT(*) as count FROM registrations
        WHERE created_at > strftime('%s', 'now', '-1 day')
    `).get();
    
    const expiredTokens = db.prepare(`
        SELECT COUNT(*) as count FROM stats
        WHERE event = 'token_expired'
    `).get();
    
    // Event breakdown
    const eventBreakdown = db.prepare(`
        SELECT event, COUNT(*) as count FROM stats
        GROUP BY event
        ORDER BY count DESC
    `).all();
    
    // Registrations by tag
    const tagStats = db.prepare(`
        SELECT tag, COUNT(*) as count FROM registrations
        GROUP BY tag
        ORDER BY count DESC
    `).all();
    
    console.log('');
    console.log('  📈 OVERALL');
    printRow('Total registrations:', totalRegs.count);
    printRow('Total events logged:', totalEvents.count);
    
    console.log('');
    console.log('  📅 LAST 24 HOURS');
    printRow('New registrations:', todayRegistrations.count);
    printRow('Pushes sent:', todayPushes.count);
    
    console.log('');
    console.log('  🏷️  BY TAG');
    if (tagStats.length === 0) {
        console.log('  No tags found');
    } else {
        tagStats.forEach(stat => {
            printRow(stat.tag, `${stat.count} device${stat.count !== 1 ? 's' : ''}`);
        });
    }
    
    console.log('');
    console.log('  📋 EVENT LOG BREAKDOWN');
    eventBreakdown.forEach(evt => {
        printRow(evt.event, evt.count);
    });
    
    console.log('');
    console.log('  ⚠️  ISSUES');
    printRow('Expired tokens:', expiredTokens.count);
    
    printFooter();
}

// ============================================
// COMMAND: clean-expired
// ============================================
function cmdCleanExpired() {
    printHeader('🧹 CLEANING EXPIRED TOKENS');
    
    // Count tokens to delete
    const expiredCount = db.prepare(`
        SELECT COUNT(*) as count FROM registrations r
        WHERE updated_at < strftime('%s', 'now', '-30 days')
    `).get();
    
    if (expiredCount.count === 0) {
        console.log('  No expired tokens to clean');
        printFooter();
        return;
    }
    
    // Show which ones will be deleted
    const expired = db.prepare(`
        SELECT id, tag, updated_at FROM registrations r
        WHERE updated_at < strftime('%s', 'now', '-30 days')
        ORDER BY updated_at DESC
    `).all();
    
    console.log(`  Found ${expiredCount.count} tokens not updated in 30+ days:\n`);
    expired.slice(0, 10).forEach(token => {
        const lastUpdate = new Date(token.updated_at * 1000);
        console.log(`    • ${token.tag} (last updated: ${lastUpdate.toISOString()})`);
    });
    
    if (expired.length > 10) {
        console.log(`    ... and ${expired.length - 10} more`);
    }
    
    console.log('');
    console.log('  ❌ Delete anyway? (This action cannot be undone)');
    console.log('  Run with: node admin-cli.js clean-expired --force');
    
    if (process.argv.includes('--force')) {
        db.prepare(`
            DELETE FROM registrations
            WHERE updated_at < strftime('%s', 'now', '-30 days')
        `).run();
        
        console.log(`\n  ✅ Deleted ${expiredCount.count} expired tokens`);
    }
    
    printFooter();
}

// ============================================
// COMMAND: delete
// ============================================
function cmdDelete(tag, tokenId) {
    if (!tag) {
        console.error('❌ Tag required. Usage: node admin-cli.js delete <tag> [token-prefix]');
        process.exit(1);
    }
    
    printHeader(`🗑️  DELETE - ${tag}`);
    
    if (tokenId) {
        // Delete specific token
        const token = db.prepare(
            'SELECT id, push_token FROM registrations WHERE tag = ? AND push_token LIKE ?'
        ).get(tag, `%${tokenId}%`);
        
        if (!token) {
            console.log(`  ❌ Token not found for tag: ${tag}`);
            printFooter();
            return;
        }
        
        const confirm = process.argv.includes('--force');
        if (confirm) {
            db.prepare('DELETE FROM registrations WHERE id = ?').run(token.id);
            console.log(`  ✅ Deleted token for ${tag}`);
        } else {
            console.log(`  Token: ${token.push_token.slice(0, 80)}...`);
            console.log('  Add --force to confirm deletion');
        }
    } else {
        // Delete all tokens for tag
        const count = db.prepare('SELECT COUNT(*) as count FROM registrations WHERE tag = ?').get(tag);
        
        if (count.count === 0) {
            console.log(`  ❌ No registrations found for tag: ${tag}`);
            printFooter();
            return;
        }
        
        if (process.argv.includes('--force')) {
            db.prepare('DELETE FROM registrations WHERE tag = ?').run(tag);
            console.log(`  ✅ Deleted ${count.count} device${count.count !== 1 ? 's' : ''} for tag: ${tag}`);
        } else {
            console.log(`  Found ${count.count} device${count.count !== 1 ? 's' : ''} for tag: ${tag}`);
            console.log('  Add --force to confirm deletion');
        }
    }
    
    printFooter();
}

// ============================================
// COMMAND: export
// ============================================
function cmdExport() {
    printHeader('📤 EXPORT TO JSON');
    
    const registrations = db.prepare('SELECT tag, push_token, created_at, updated_at FROM registrations ORDER BY tag').all();
    const stats = db.prepare('SELECT event, details, created_at FROM stats ORDER BY created_at DESC LIMIT 1000').all();
    
    const data = {
        exportedAt: new Date().toISOString(),
        summary: {
            registrations: registrations.length,
            recentEvents: stats.length
        },
        data: {
            registrations,
            stats
        }
    };
    
    const filename = `pombo-relay-export-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    
    console.log(`  ✅ Exported to: ${filename}`);
    console.log(`     Registrations: ${registrations.length}`);
    console.log(`     Events: ${stats.length}`);
    
    printFooter();
}

// ============================================
// COMMAND: events
// ============================================
function cmdEvents(limit = 50) {
    printHeader(`📜 RECENT EVENTS (Last ${limit})`);
    
    const events = db.prepare(`
        SELECT event, details, created_at FROM stats
        ORDER BY created_at DESC
        LIMIT ?
    `).all(limit);
    
    if (events.length === 0) {
        console.log('  No events logged');
        printFooter();
        return;
    }
    
    events.forEach((evt, idx) => {
        const time = new Date(evt.created_at * 1000).toISOString();
        console.log(`  [${idx + 1}] ${time} | ${evt.event}`);
        if (evt.details) {
            const details = evt.details.length > 100 
                ? evt.details.slice(0, 100) + '...'
                : evt.details;
            console.log(`       → ${details}`);
        }
    });
    
    printFooter();
}

// ============================================
// COMMAND: info
// ============================================
function cmdInfo() {
    printHeader('ℹ️  ADMIN CLI - AVAILABLE COMMANDS');
    
    console.log('');
    console.log('  📋 list [tag]');
    console.log('      Show all registrations (optionally filter by tag)');
    console.log('      Example: node admin-cli.js list');
    console.log('      Example: node admin-cli.js list pombo/chat');
    
    console.log('');
    console.log('  📊 stats');
    console.log('      Show overall statistics and breakdown');
    console.log('      Example: node admin-cli.js stats');
    
    console.log('');
    console.log('  📜 events [limit]');
    console.log('      Show recent events from log (default 50)');
    console.log('      Example: node admin-cli.js events 100');
    
    console.log('');
    console.log('  🗑️  delete <tag> [token-prefix]');
    console.log('      Delete registrations by tag (or specific token)');
    console.log('      Example: node admin-cli.js delete pombo/chat --force');
    console.log('      Example: node admin-cli.js delete pombo/dm abc123... --force');
    
    console.log('');
    console.log('  🧹 clean-expired');
    console.log('      Remove tokens not updated in 30+ days');
    console.log('      Example: node admin-cli.js clean-expired --force');
    
    console.log('');
    console.log('  📤 export');
    console.log('      Export all data to JSON file');
    console.log('      Example: node admin-cli.js export');
    
    console.log('');
    console.log('  ℹ️  help');
    console.log('      Show this help message');
    console.log('');
}

function printFooter() {
    console.log('');
}

// ============================================
// MAIN
// ============================================

if (!command || command === 'help') {
    cmdInfo();
} else if (command === 'list') {
    cmdList(arg1);
} else if (command === 'stats') {
    cmdStats();
} else if (command === 'events') {
    const limit = parseInt(arg1) || 50;
    cmdEvents(limit);
} else if (command === 'delete') {
    cmdDelete(arg1, arg2);
} else if (command === 'clean-expired') {
    cmdCleanExpired();
} else if (command === 'export') {
    cmdExport();
} else {
    console.error(`❌ Unknown command: ${command}`);
    console.error('Run: node admin-cli.js help');
    process.exit(1);
}

db.close();
