import { loadConfig } from "@archive/config";
import { createDatabase, createRecoveryAdmin, migrateDatabase } from "@archive/core";

function usage(): never {
  console.error(
    "Usage: RECOVERY_SECRET=... DATABASE_URL=... APP_ROLE=web node apps/web/dist/recovery.js --username NAME --password PASS",
  );
  process.exit(1);
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === `--${name}`) {
      const index = process.argv.indexOf(arg);
      return process.argv[index + 1];
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.role !== "web") {
    throw new Error(`recovery requires APP_ROLE=web, got ${config.role}`);
  }

  const username = readArg("username");
  const password = readArg("password");
  const recoverySecret = readArg("recovery-secret") ?? process.env.RECOVERY_SECRET;
  if (!username || !password || !recoverySecret) {
    usage();
  }

  await migrateDatabase(config.databaseUrl);
  const db = createDatabase(config.databaseUrl);
  try {
    const result = await createRecoveryAdmin(db, {
      username,
      password,
      recoverySecret,
      expectedRecoverySecret: config.recoverySecret ?? "",
    });
    console.log(
      JSON.stringify({
        ok: true,
        username: result.user.username,
        sessionsRevoked: result.sessionsRevoked,
      }),
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
