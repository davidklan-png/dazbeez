import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { NextConfig } from "next";
import * as phases from "next/constants";
import ts from "typescript";

test("Cloudflare bindings stay local during builds and remote-enabled in dev", () => {
  const initializations: unknown[] = [];
  const configModule = {
    exports: {} as { default: (phase: string) => NextConfig },
  };
  const source = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  // Execute the real config without starting Wrangler or a remote preview session.
  new Function("require", "module", "exports", outputText)(
    (name: string) => {
      if (name === "@opennextjs/cloudflare") {
        return {
          initOpenNextCloudflareForDev: (options: unknown) => {
            initializations.push(options);
          },
        };
      }
      assert.equal(name, "next/constants");
      return phases;
    },
    configModule,
    configModule.exports,
  );
  assert.deepEqual(initializations, [], "loading config must wait for its phase");

  const buildConfig = configModule.exports.default(phases.PHASE_PRODUCTION_BUILD);
  const devConfig = configModule.exports.default(phases.PHASE_DEVELOPMENT_SERVER);
  const serverConfig = configModule.exports.default(phases.PHASE_PRODUCTION_SERVER);
  assert.deepEqual(initializations, [
    { remoteBindings: false },
    { remoteBindings: true },
    { remoteBindings: true },
  ]);
  assert.equal(devConfig, buildConfig);
  assert.equal(serverConfig, buildConfig);
  assert.equal(buildConfig.reactStrictMode, true);
});
