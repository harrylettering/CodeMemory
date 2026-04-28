#!/usr/bin/env node
/**
 * CodeMemory - Database Initialization Script
 * Initializes the SQLite database with required tables.
 */
import { resolveCodeMemoryConfig } from "../../db/config.js";
import { createCodeMemoryDatabaseConnection } from "../../db/connection.js";
async function main() {
    try {
        const config = resolveCodeMemoryConfig();
        console.error(`[codememory] Initializing database at ${config.databasePath}`);
        const db = await createCodeMemoryDatabaseConnection(config.databasePath);
        await db.close();
        console.error("[codememory] Database initialized successfully");
        process.exit(0);
    }
    catch (error) {
        console.error(`[codememory] Database initialization failed: ${error}`);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=init-db.js.map