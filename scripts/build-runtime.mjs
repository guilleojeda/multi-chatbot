import { builtinModules } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPoint = path.join(projectRoot, "runtime/entry.ts");
const dockerfile = path.join(projectRoot, "runtime/Dockerfile");
const outputDirectory = path.join(projectRoot, "dist/runtime-image");
const outputFile = path.join(outputDirectory, "entry.mjs");
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
// ws@8.22.0 treats these peer dependencies as optional and catches failed requires,
// retaining its pure-JavaScript masking and UTF-8 validation implementations.
const optionalPeerFallbacks = new Set(["bufferutil", "utf-8-validate"]);
const agentCoreAppPattern = /[\\/]bedrock-agentcore[\\/]dist[\\/]src[\\/]runtime[\\/]app\.js$/;
// AgentCore uses createRequire for these CJS plugins, which esbuild cannot bundle from the dynamic call.
const agentCoreDynamicPluginImports = [
  "const require = createRequire(import.meta.url);",
  "const fastifySse = require('@fastify/sse');",
  "const fastifyWebsocket = require('@fastify/websocket');",
].join("\n");
let bundledAgentCorePlugins = false;

if (!existsSync(entryPoint)) {
  throw new Error(`Runtime entrypoint does not exist: ${path.relative(projectRoot, entryPoint)}`);
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

try {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: outputFile,
    banner: {
      js: 'import { createRequire as __runtimeCreateRequire } from "node:module";\nconst require = __runtimeCreateRequire(import.meta.url);',
    },
    metafile: true,
    plugins: [
      {
        name: "bundle-agentcore-runtime-fastify-plugins",
        setup(build) {
          build.onLoad({ filter: agentCoreAppPattern }, ({ path: appPath }) => {
            const source = readFileSync(appPath, "utf8");
            if (!source.includes(agentCoreDynamicPluginImports)) {
              throw new Error(
                "AgentCore runtime Fastify plugin imports changed; update the bundle transform.",
              );
            }

            const transformed = source
              .replace("import { createRequire } from 'module';\n", "")
              .replace(
                agentCoreDynamicPluginImports,
                "import fastifySse from '@fastify/sse';\nimport fastifyWebsocket from '@fastify/websocket';",
              );
            bundledAgentCorePlugins = true;
            return { contents: transformed, loader: "js" };
          });
        },
      },
    ],
  });

  if (!bundledAgentCorePlugins) {
    throw new Error("AgentCore runtime Fastify plugins were not statically bundled.");
  }

  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
      ({ external, path: importPath }) =>
        external && !nodeBuiltins.has(importPath) && !optionalPeerFallbacks.has(importPath),
    );

  if (externalImports.length > 0) {
    const imports = [...new Set(externalImports.map(({ path: importPath }) => importPath))];
    throw new Error(`Runtime bundle has non-Node external imports: ${imports.join(", ")}`);
  }

  copyFileSync(dockerfile, path.join(outputDirectory, "Dockerfile"));
  console.log(
    `Prepared self-contained Runtime image context at ${path.relative(projectRoot, outputDirectory)}.`,
  );
} catch (error) {
  rmSync(outputDirectory, { recursive: true, force: true });
  throw error;
}
