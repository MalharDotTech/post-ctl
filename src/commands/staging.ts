import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, saveConfig, type StagingConfig } from "../config.ts";
import { saveToken, loadToken, deleteToken } from "../token-store.ts";
import { stageFile, STAGING_SECRET_KEY } from "../stage.ts";
import { ValidationError } from "../errors.ts";
import { detectFormat, printDoc } from "../output.ts";
import type { ParsedArgs } from "../args.ts";
import { stringFlag } from "../args.ts";

export async function stagingCmd(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "status";
  const format = detectFormat(stringFlag(args.flags, "output"));

  switch (sub) {
    case "set": {
      const endpoint = stringFlag(args.flags, "endpoint");
      const bucket = stringFlag(args.flags, "bucket");
      const accessKeyId = stringFlag(args.flags, "access-key-id");
      const secretAccessKey = stringFlag(args.flags, "secret-access-key");
      const existing = loadConfig().staging;
      if (!endpoint && !existing?.endpoint || !bucket && !existing?.bucket) {
        throw new ValidationError(
          "Usage: postctl staging set --endpoint <url> --bucket <name> --region auto --access-key-id <id> --secret-access-key <key> [--prefix postctl/] [--ttl 3600] [--backend r2]",
        );
      }
      const cfg = loadConfig();
      cfg.staging = {
        backend: (stringFlag(args.flags, "backend") ?? existing?.backend ?? "r2") as StagingConfig["backend"],
        endpoint: endpoint ?? existing!.endpoint,
        bucket: bucket ?? existing!.bucket,
        region: stringFlag(args.flags, "region") ?? existing?.region ?? "auto",
        accessKeyId: accessKeyId ?? existing?.accessKeyId ?? "",
        prefix: stringFlag(args.flags, "prefix") ?? existing?.prefix ?? "postctl/",
        presignTtlSeconds: Number(stringFlag(args.flags, "ttl") ?? existing?.presignTtlSeconds ?? 3600),
      };
      if (!cfg.staging.accessKeyId) throw new ValidationError("Missing --access-key-id");
      saveConfig(cfg);
      if (secretAccessKey) {
        saveToken(STAGING_SECRET_KEY, {
          access_token: secretAccessKey,     // token-store reuse: secret in access_token
          expires_at: Number.MAX_SAFE_INTEGER,
          obtained_at: Date.now(),
        });
      } else if (!loadToken(STAGING_SECRET_KEY)) {
        throw new ValidationError("Missing --secret-access-key (no stored secret found)");
      }
      printDoc({ staging: "configured", endpoint: cfg.staging.endpoint, bucket: cfg.staging.bucket }, format);
      return;
    }

    case "status": {
      const staging = loadConfig().staging;
      if (!staging) {
        printDoc({ staging: "not configured", fix: "postctl staging set --endpoint … --bucket … --access-key-id … --secret-access-key …" }, format);
        return;
      }
      printDoc({
        backend: staging.backend,
        endpoint: staging.endpoint,
        bucket: staging.bucket,
        region: staging.region,
        accessKeyId: staging.accessKeyId,
        prefix: staging.prefix ?? "postctl/",
        presignTtlSeconds: staging.presignTtlSeconds ?? 3600,
        secret: loadToken(STAGING_SECRET_KEY) ? "stored" : "MISSING",
      }, format);
      return;
    }

    // Round-trip proof: PUT a probe object, fetch it back through the
    // presigned GET (what Meta will do), DELETE it. Works against real R2
    // or any local S3-compatible endpoint.
    case "test": {
      const probe = join(tmpdir(), `postctl-staging-probe-${Date.now()}.png`);
      // 1x1 transparent PNG
      writeFileSync(probe, Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ));
      try {
        const staged = await stageFile(probe);
        const res = await fetch(staged.url);
        const roundTripOk = res.ok && (await res.arrayBuffer()).byteLength > 0;
        await staged.cleanup();
        printDoc({
          staging_test: roundTripOk ? "pass" : "fail",
          upload: "ok",
          presigned_get: res.ok ? "ok" : `failed (${res.status})`,
          cleanup: "attempted",
        }, format);
        if (!roundTripOk) process.exitCode = 1;
      } finally {
        rmSync(probe, { force: true });
      }
      return;
    }

    case "unset": {
      const cfg = loadConfig();
      delete cfg.staging;
      saveConfig(cfg);
      deleteToken(STAGING_SECRET_KEY);
      console.log("Staging config and secret removed.");
      return;
    }

    default:
      throw new ValidationError(`Unknown subcommand 'staging ${sub}'. Use: set | status | test | unset`);
  }
}
