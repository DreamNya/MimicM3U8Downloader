import path from "node:path";
import { parseArgs } from "node:util";
import { getFixtures, segmentSeconds, serveFixtures, variants } from "./fixtures.mjs";
import { verify } from "./verify.mjs";

const quickSeconds = 12;
const longSeconds = 300;

const help = `Local HLS download tests (Node.js v26, ffmpeg with drawtext/libx264, ffprobe)

npm run test:hls:build  -- [--seconds n] [--fixtures disk|memory]
npm run test:hls:serve  -- [--seconds ${longSeconds}] [--fixtures disk|memory]
npm run test:hls        -- [--seconds ${quickSeconds}] [--variant all|${variants.join("|")}]
                           [--scenario full|range|retry|skip] [--samples 3]
                           [--fixtures disk|memory] [--video memory|disk] [--verification memory|disk]
npm run test:hls:worker -- [same options] [--mode normal|mp4|fmp4] [--scenario resume]
                           [--video memory --ram-dir <mounted RAM disk>]

The build command prepares ${quickSeconds}s and ${longSeconds}s fixtures by default.
Commands reuse cached fixtures by duration and generate them on a cache miss.
Use --fixtures memory to generate fixtures in memory for a single run.
Video and reports default to memory, with disk video for the Worker script.
The Worker needs a RAM disk for its workspace when using --video memory.`;

async function prepareFixtures(seconds, storage) {
    const fixtures = await getFixtures(seconds, storage);
    if (fixtures.directory) {
        const action = fixtures.cacheHit ? "Reusing" : "Generated";
        console.log(`${action} ${seconds}s HLS fixtures at ${fixtures.directory}`);
    } else {
        console.log(`Generated ${seconds}s HLS fixtures in memory`);
    }
    return fixtures;
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const { values } = parseArgs({
        args,
        options: {
            help: { type: "boolean" },
            seconds: { type: "string" },
            fixtures: { type: "string", default: "disk" },
            video: { type: "string", default: "memory" },
            verification: { type: "string", default: "memory" },
            samples: { type: "string", default: "3" },
            variant: { type: "string", default: "all" },
            scenario: { type: "string", default: "full" },
            engine: { type: "string", default: "memory" },
            mode: { type: "string", default: "fmp4" },
            "ram-dir": { type: "string" },
        },
    });
    if (values.help) {
        console.log(help);
        return;
    }
    if (!["build", "serve", "verify"].includes(command)) {
        throw new Error("Expected build, serve or verify. Use --help to see the available options.");
    }
    const options = {
        ...values,
        seconds: Number(values.seconds ?? (command === "verify" ? quickSeconds : longSeconds)),
        samples: Number(values.samples),
    };
    if (!Number.isInteger(options.seconds) || options.seconds < 6 || options.seconds > 600 || options.seconds % segmentSeconds) {
        throw new Error("--seconds must be an even integer between 6 and 600");
    }
    if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
        throw new Error("--samples must be a positive integer");
    }
    for (const [name, choices] of Object.entries({
        fixtures: ["memory", "disk"],
        video: ["memory", "disk"],
        verification: ["memory", "disk"],
        variant: ["all", ...variants],
        scenario: ["full", "range", "retry", "skip", "resume"],
        engine: ["memory", "worker"],
        mode: ["normal", "mp4", "fmp4"],
    })) {
        if (!choices.includes(options[name])) {
            throw new Error(`--${name} must be one of ${choices.join(", ")}`);
        }
    }
    if (command === "verify" && options.scenario === "resume" && (options.engine !== "worker" || options.mode !== "fmp4")) {
        throw new Error("The resume scenario requires the Worker with --mode fmp4");
    }
    if (command === "verify" && options.engine === "worker" && options.video === "memory") {
        if (!options["ram-dir"] && process.platform !== "linux") {
            throw new Error("The Worker needs --ram-dir pointing to a mounted RAM disk when --video memory is selected");
        }
        if (options["ram-dir"]) {
            options["ram-dir"] = path.resolve(options["ram-dir"]);
        }
    }

    if (command === "build") {
        const durations = values.seconds === undefined ? [quickSeconds, longSeconds] : [options.seconds];
        for (const seconds of durations) {
            await prepareFixtures(seconds, options.fixtures);
        }
        return;
    }

    const fixtures = await prepareFixtures(options.seconds, options.fixtures);
    if (command === "serve") {
        const server = await serveFixtures(fixtures.files);
        console.log("Local HLS URLs (press Ctrl+C to stop)");
        for (const variant of options.variant === "all" ? variants : [options.variant]) {
            console.log(`${server.origin}/${variant}/media.m3u8`);
        }
        try {
            await new Promise((resolve) => {
                process.once("SIGINT", resolve);
                process.once("SIGTERM", resolve);
            });
        } finally {
            await server.close();
        }
    } else {
        await verify(options, fixtures);
    }
}

try {
    await main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
