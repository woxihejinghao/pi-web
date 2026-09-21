import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KNOWN_PROVIDERS,
  ModelConfigError,
  authPath,
  deleteProvider,
  fetchProviderModels,
  modelsPath,
  readProviders,
  saveProvider,
  validateProviderId,
} from "./models.ts";

/**
 * Every test points pi at a scratch agent directory. `getAgentDir()` reads
 * `PI_CODING_AGENT_DIR` on each call precisely so this is possible; without it
 * these tests would edit the real `~/.pi/agent/models.json`.
 */
let agentDir: string;

const real = {
  providers: {
    cz: {
      name: "cz",
      baseUrl: "https://ai-work.changzhi.top",
      api: "anthropic-messages",
      models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
    },
    commandcode: {
      name: "commandcode",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      api: "openai-completions",
      models: [{ id: "zai-org/GLM-5.3" }],
    },
  },
};

async function seed(models: unknown, auth: unknown = {}): Promise<void> {
  await writeFile(modelsPath(), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  await writeFile(authPath(), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function readModelsFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(modelsPath(), "utf8"));
}

async function readAuthFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(authPath(), "utf8"));
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "piws-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

describe("readProviders", () => {
  it("returns nothing when neither file exists", async () => {
    expect(await readProviders()).toEqual([]);
  });

  it("merges models.json definitions with auth.json credentials", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-cz" } });

    const providers = await readProviders();
    expect(providers.map((p) => p.id)).toEqual(["cz", "commandcode"]);
    const cz = providers[0]!;
    expect(cz.name).toBe("cz");
    expect(cz.baseUrl).toBe("https://ai-work.changzhi.top");
    expect(cz.api).toBe("anthropic-messages");
    expect(cz.models).toEqual([{ id: "deepseek-flash", name: "DeepSeek Flash" }]);
  });

  it("marks an id outside pi's catalog as custom", async () => {
    // This is the badge the settings page shows. `cz` was invented by the user;
    // `deepseek` is a provider pi already knows the endpoint and protocol for.
    await seed({ providers: { cz: real.providers.cz, deepseek: { name: "DeepSeek" } } }, {});

    const providers = await readProviders();
    expect(providers.find((p) => p.id === "cz")!.custom).toBe(true);
    expect(providers.find((p) => p.id === "deepseek")!.custom).toBe(false);
    expect(KNOWN_PROVIDERS).toContain("deepseek");
  });

  it("reports a credential from either store, and where it came from", async () => {
    await seed(
      {
        providers: {
          cz: { name: "cz", apiKey: "sk-inline" },
          commandcode: { name: "commandcode" },
        },
      },
      { commandcode: { type: "api_key", key: "sk-auth" } },
    );

    const providers = await readProviders();
    expect(providers.find((p) => p.id === "cz")).toMatchObject({
      configured: true,
      keySource: "inline",
    });
    expect(providers.find((p) => p.id === "commandcode")).toMatchObject({
      configured: true,
      keySource: "auth",
    });
  });

  it("reports a provider with no credential as unconfigured", async () => {
    await seed({ providers: { cz: { name: "cz" } } }, {});
    expect(await readProviders()).toMatchObject([{ configured: false, keySource: null }]);
  });

  it("never returns the key itself", async () => {
    // The page is shown in a browser and the view object is serialized into
    // HTTP; a key that reached this structure would be a leak, so the shape is
    // asserted rather than left to reviewers.
    await seed(real, { cz: { type: "api_key", key: "sk-secret-value" } });

    const serialized = JSON.stringify(await readProviders());
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("apiKey");
  });

  it("returns providers in the order models.json lists them", async () => {
    // Not sorted: the user's own order is the one they expect, and it is the
    // order dsh renders too.
    await seed(
      {
        providers: {
          openai: {},
          "zz-custom": {},
          anthropic: {},
          "aa-custom": {},
        },
      },
      {},
    );
    expect((await readProviders()).map((p) => p.id)).toEqual([
      "openai",
      "zz-custom",
      "anthropic",
      "aa-custom",
    ]);
  });

  it("names a provider without a display name by its id", async () => {
    await seed({ providers: { cz: { baseUrl: "https://x.test" } } }, {});
    expect((await readProviders())[0]!.name).toBe("cz");
  });

  it("rejects a config file that is not valid JSON", async () => {
    await writeFile(modelsPath(), "{ not json", "utf8");
    await expect(readProviders()).rejects.toThrow(/not valid JSON/);
  });
});

describe("saveProvider", () => {
  it("creates a provider and stores the key in auth.json", async () => {
    await seed({ providers: {} }, {});

    const saved = await saveProvider(
      {
        id: "newco",
        name: "NewCo",
        baseUrl: "https://api.newco.test/v1",
        api: "openai-completions",
        apiKey: "sk-new",
        models: [{ id: "big-model" }],
      },
      "create",
    );

    expect(saved).toMatchObject({ id: "newco", configured: true, custom: true });
    expect(await readModelsFile()).toMatchObject({
      providers: {
        newco: {
          name: "NewCo",
          baseUrl: "https://api.newco.test/v1",
          api: "openai-completions",
          models: [{ id: "big-model" }],
        },
      },
    });
    expect(await readAuthFile()).toEqual({ newco: { type: "api_key", key: "sk-new" } });
  });

  it("refuses to overwrite an existing id when creating", async () => {
    await seed(real, {});
    await expect(saveProvider({ id: "cz", apiKey: "sk-x" }, "create")).rejects.toThrow(
      /已有提供方使用了这个 ID/,
    );
  });

  it("refuses to update an id that does not exist", async () => {
    await seed(real, {});
    await expect(saveProvider({ id: "nope" }, "update")).rejects.toThrow(/没有找到提供方/);
  });

  it("preserves fields it does not understand", async () => {
    // The provider schema is far larger than this UI renders. A save that
    // rebuilt the entry from rendered fields only would drop `compat`,
    // `modelOverrides`, per-model `cost` and `contextWindow` — silently
    // breaking a provider that worked before the user opened the editor.
    await seed(
      {
        providers: {
          cz: {
            name: "cz",
            baseUrl: "https://old.test",
            compat: { thinkingFormat: "deepseek" },
            modelOverrides: { "deepseek-flash": { contextWindow: 131072 } },
            models: [{ id: "deepseek-flash", cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
          },
        },
      },
      {},
    );

    await saveProvider({ id: "cz", name: "Renamed" }, "update");

    const cz = (await readModelsFile()).providers.cz;
    expect(cz.name).toBe("Renamed");
    expect(cz.compat).toEqual({ thinkingFormat: "deepseek" });
    expect(cz.modelOverrides).toEqual({ "deepseek-flash": { contextWindow: 131072 } });
    expect(cz.models[0].cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 });
  });

  it("keeps the stored key when the save does not carry one", async () => {
    // The editor never receives the current key, so it cannot send it back.
    // Omitting `apiKey` must mean "unchanged" — otherwise every rename would
    // wipe the credential.
    await seed(real, { cz: { type: "api_key", key: "sk-keep" } });

    const saved = await saveProvider({ id: "cz", name: "Renamed" }, "update");

    expect(await readAuthFile()).toEqual({ cz: { type: "api_key", key: "sk-keep" } });
    expect(saved.configured).toBe(true);
  });

  it("clears the stored key when given an empty string", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-drop" } });

    const saved = await saveProvider({ id: "cz", apiKey: "" }, "update");

    expect(await readAuthFile()).toEqual({});
    expect(saved.configured).toBe(false);
  });

  it("drops an inline key when a new one is written", async () => {
    // pi treats `models.json.apiKey` and `auth.json` as equally valid, so an
    // inline key would shadow the one just saved and the editor cannot show it
    // to warn the user.
    await seed({ providers: { cz: { name: "cz", apiKey: "sk-inline-old" } } }, {});

    await saveProvider({ id: "cz", apiKey: "sk-new" }, "update");

    expect((await readModelsFile()).providers.cz.apiKey).toBeUndefined();
    expect(await readAuthFile()).toEqual({ cz: { type: "api_key", key: "sk-new" } });
  });

  it("leaves an inline key alone when no new key is given", async () => {
    await seed({ providers: { cz: { name: "cz", apiKey: "sk-inline-old" } } }, {});

    await saveProvider({ id: "cz", name: "Renamed" }, "update");

    expect((await readModelsFile()).providers.cz.apiKey).toBe("sk-inline-old");
  });

  it("clears an optional field when given an empty string", async () => {
    await seed(real, {});
    await saveProvider({ id: "cz", baseUrl: "", api: "" }, "update");

    const cz = (await readModelsFile()).providers.cz;
    expect(cz.baseUrl).toBeUndefined();
    expect(cz.api).toBeUndefined();
  });

  it("rejects a malformed provider id", () => {
    for (const bad of ["Cz", "1cz", "-cz", "cz_1", "cz.1", ""]) {
      expect(() => validateProviderId(bad)).toThrow(ModelConfigError);
    }
    expect(validateProviderId("cz")).toBe("cz");
    expect(validateProviderId("my-provider-2")).toBe("my-provider-2");
  });

  it("rejects a base URL that is not http(s)", async () => {
    await seed({ providers: {} }, {});
    for (const bad of ["ftp://x.test", "not a url", "file:///etc/passwd"]) {
      await expect(saveProvider({ id: "newco", baseUrl: bad }, "create")).rejects.toThrow(
        /HTTP 或 HTTPS/,
      );
    }
  });

  it("writes a backup before changing either file", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-old" } });

    await saveProvider({ id: "cz", apiKey: "sk-new" }, "update");

    const files = await readdir(agentDir);
    const backups = files.filter((f) => f.includes(".bak.pi-web-simple-"));
    // One for models.json, one for auth.json — both were modified.
    expect(backups).toHaveLength(2);
    const modelsBackup = files.find((f) => f.startsWith("models.json.bak"));
    expect(JSON.parse(await readFile(join(agentDir, modelsBackup!), "utf8"))).toEqual(real);
  });
});

describe("deleteProvider", () => {
  it("removes the provider and its stored credential", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-cz" } });

    await deleteProvider("cz");

    expect(Object.keys((await readModelsFile()).providers)).toEqual(["commandcode"]);
    expect(await readAuthFile()).toEqual({});
  });

  it("keeps other providers' credentials", async () => {
    await seed(real, {
      cz: { type: "api_key", key: "sk-cz" },
      commandcode: { type: "api_key", key: "sk-cc" },
    });

    await deleteProvider("cz");

    expect(await readAuthFile()).toEqual({ commandcode: { type: "api_key", key: "sk-cc" } });
  });

  it("reports an unknown id instead of silently succeeding", async () => {
    await seed(real, {});
    await expect(deleteProvider("ghost")).rejects.toThrow(/没有找到提供方/);
  });
});

describe("saveProvider model merging", () => {
  it("keeps every field of a model the editor only renders an id and name for", async () => {
    // Caught by running the real UI: renaming a provider came back with every
    // model stripped to `{id, name}`, dropping a declared 1M context window.
    await seed(
      {
        providers: {
          cz: {
            name: "cz",
            models: [
              {
                id: "deepseek-flash",
                name: "DeepSeek Flash",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 1000000,
                maxTokens: 16384,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                thinkingLevelMap: { max: "max" },
                compat: { supportsDeveloperRole: false },
              },
            ],
          },
        },
      },
      {},
    );

    // What the editor sends back after a rename: only id and name per model.
    await saveProvider(
      { id: "cz", name: "Renamed", models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] },
      "update",
    );

    expect((await readModelsFile()).providers.cz.models[0]).toEqual({
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { max: "max" },
      compat: { supportsDeveloperRole: false },
    });
  });

  it("updates a model's display name without touching its other fields", async () => {
    await seed(
      { providers: { cz: { name: "cz", models: [{ id: "m", name: "Old", contextWindow: 4096 }] } } },
      {},
    );

    await saveProvider({ id: "cz", models: [{ id: "m", name: "New" }] }, "update");

    expect((await readModelsFile()).providers.cz.models[0]).toEqual({
      id: "m",
      name: "New",
      contextWindow: 4096,
    });
  });

  it("drops a name that was cleared, rather than storing an empty string", async () => {
    await seed({ providers: { cz: { name: "cz", models: [{ id: "m", name: "Old" }] } } }, {});

    await saveProvider({ id: "cz", models: [{ id: "m" }] }, "update");

    const model = (await readModelsFile()).providers.cz.models[0];
    expect(model).toEqual({ id: "m" });
    expect("name" in model).toBe(false);
  });

  it("removes a model the editor dropped from the list", async () => {
    await seed(
      { providers: { cz: { name: "cz", models: [{ id: "a" }, { id: "b" }] } } },
      {},
    );

    await saveProvider({ id: "cz", models: [{ id: "a" }] }, "update");

    expect((await readModelsFile()).providers.cz.models).toEqual([{ id: "a" }]);
  });

  it("adds a brand new model as just an id", async () => {
    await seed({ providers: { cz: { name: "cz", models: [] } } }, {});

    await saveProvider({ id: "cz", models: [{ id: "fresh", name: "Fresh" }] }, "update");

    expect((await readModelsFile()).providers.cz.models).toEqual([{ id: "fresh", name: "Fresh" }]);
  });

  it("leaves the model list alone when the editor sends none", async () => {
    await seed(
      { providers: { cz: { name: "cz", models: [{ id: "m", contextWindow: 8192 }] } } },
      {},
    );

    await saveProvider({ id: "cz", name: "Renamed" }, "update");

    expect((await readModelsFile()).providers.cz.models).toEqual([
      { id: "m", contextWindow: 8192 },
    ]);
  });
});

describe("fetchProviderModels", () => {
  // A local stand-in for a provider's catalog endpoint, so these tests never
  // touch the network. It records what it was asked for, which is how the
  // endpoint and header choices are asserted rather than assumed.
  let server: import("node:http").Server;
  let base: string;
  let received: { url: string; headers: import("node:http").IncomingHttpHeaders }[] = [];
  let respond: (res: import("node:http").ServerResponse) => void;

  beforeEach(async () => {
    received = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    };
    const { createServer } = await import("node:http");
    server = createServer((req, res) => {
      received.push({ url: req.url ?? "", headers: req.headers });
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("asks an OpenAI-shaped provider at {base}/models with a bearer token", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-x", name: "GPT X" }, { id: "gpt-y" }] }));
    };

    const models = await fetchProviderModels({
      baseUrl: base,
      api: "openai-completions",
      apiKey: "sk-live",
    });

    expect(received[0]!.url).toBe("/models");
    expect(received[0]!.headers.authorization).toBe("Bearer sk-live");
    expect(models).toEqual([{ id: "gpt-x", name: "GPT X" }, { id: "gpt-y" }]);
  });

  it("asks an Anthropic-shaped provider at {base}/v1/models with x-api-key", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-x", display_name: "Claude X" }] }));
    };

    const models = await fetchProviderModels({
      baseUrl: base,
      api: "anthropic-messages",
      apiKey: "sk-ant",
    });

    expect(received[0]!.url).toBe("/v1/models");
    expect(received[0]!.headers["x-api-key"]).toBe("sk-ant");
    expect(received[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(received[0]!.headers.authorization).toBeUndefined();
    // Anthropic calls the label `display_name`.
    expect(models).toEqual([{ id: "claude-x", name: "Claude X" }]);
  });

  it("does not repeat a version prefix the user already typed", async () => {
    // A base URL pasted as `https://host/v1` is common; /v1/v1/models is not a
    // path any provider serves.
    await fetchProviderModels({ baseUrl: `${base}/v1`, api: "anthropic-messages" });
    expect(received[0]!.url).toBe("/v1/models");

    // And a trailing slash must not produce a doubled separator.
    await fetchProviderModels({ baseUrl: `${base}/`, api: "openai-completions" });
    expect(received[1]!.url).toBe("/models");
  });

  it("falls back to the stored credential when none is supplied", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-stored" } });

    await fetchProviderModels({ id: "cz", baseUrl: base, api: "openai-completions" });

    expect(received[0]!.headers.authorization).toBe("Bearer sk-stored");
  });

  it("prefers a typed key over the stored one", async () => {
    await seed(real, { cz: { type: "api_key", key: "sk-stored" } });

    await fetchProviderModels({
      id: "cz",
      baseUrl: base,
      api: "openai-completions",
      apiKey: "sk-typed",
    });

    expect(received[0]!.headers.authorization).toBe("Bearer sk-typed");
  });

  it("still asks when there is no credential at all", async () => {
    // Local gateways are routinely unauthenticated; refusing to ask would make
    // those providers impossible to populate.
    await fetchProviderModels({ baseUrl: base, api: "openai-completions" });
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.url).toBe("/models");
  });

  it("surfaces the status code when the provider rejects the request", async () => {
    respond = (res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("invalid api key");
    };

    await expect(fetchProviderModels({ baseUrl: base, apiKey: "sk-bad" })).rejects.toThrow(
      /提供方返回 401：invalid api key/,
    );
  });

  it("accepts the other shapes self-hosted gateways return", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ id: "m1" }] }));
    };
    expect(await fetchProviderModels({ baseUrl: base })).toEqual([{ id: "m1" }]);

    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(["m1", "m2"]));
    };
    expect(await fetchProviderModels({ baseUrl: base })).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("reports an empty catalog as an empty list, not an error", async () => {
    expect(await fetchProviderModels({ baseUrl: base })).toEqual([]);
  });

  it("deduplicates entries and drops ones without an id", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "a" }, { id: "a" }, { name: "no id" }, { id: "" }, "a", "b"],
        }),
      );
    };
    expect(await fetchProviderModels({ baseUrl: base })).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("rejects a response with no model list in it", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };
    await expect(fetchProviderModels({ baseUrl: base })).rejects.toThrow(/无法从提供方的响应里找到模型列表/);
  });

  it("rejects a non-JSON response", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    };
    await expect(fetchProviderModels({ baseUrl: base })).rejects.toThrow(/不是 JSON/);
  });

  it("rejects a base URL that is not http(s) before making a request", async () => {
    await expect(fetchProviderModels({ baseUrl: "file:///etc/passwd" })).rejects.toThrow(
      /HTTP 或 HTTPS/,
    );
    expect(received).toHaveLength(0);
  });

  it("reports an unreachable host as a connection failure", async () => {
    await expect(
      fetchProviderModels({ baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" }),
    ).rejects.toThrow(/无法连接/);
  });
});
