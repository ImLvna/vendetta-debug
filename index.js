// Suppress Node.js warning about experimental fetch API
// Ref: https://github.com/nodejs/node/issues/30810#issuecomment-1383184769
const originalEmit = process.emit;
process.emit = function (event, error) {
	if (
		event === "warning" &&
		error.name === "ExperimentalWarning" &&
		error.message.includes(
			"Importing JSON modules is an experimental feature and might change at any time"
		)
	) {
		return false;
	}

	return originalEmit.apply(process, arguments);
};
let WebSocketServer, colors;
try {
	WebSocketServer = (await import("ws")).WebSocketServer;
	colors = (await import("ansi-colors")).default;
} catch (err) {
	console.error(
		"You forgot to install the dependencies.\n" +
			"https://github.com/Meqativ/vendetta-debug#installing"
	);
	process.exit(1);
}
import { hostname } from "os";
import repl from "repl";
import { parseArgs } from "util";
import * as fs from "fs/promises";
import defaults from "./defaults.json" assert { type: "json" };

const COLORS = {
	client: {
		info: colors.cyan,
		warning: colors.yellow,
		error: colors.red,
	},
	debugger: {
		info: colors.magenta.bold,
		warning: colors.yellow.bold,
		error: colors.red.bold,
	},
};
let isPrompting = false;
const args = parseArgs({
	options: {
		h: { type: "boolean" },
		silent: { type: "string", default: `${defaults?.silent}` },
		port: { type: "string", default: `${defaults?.port}` ?? "9090" },
		onConnectedPath: { type: "string", default: defaults?.onConnectedPath },
		help: { type: "boolean", default: false },
	},
});
if (args?.values.help || args?.values?.h) {
	let cmdlu;
	try {
		cmdlu = (await import("command-line-usage")).default;
		const { generate } = (await import("./help.js"))
		console.log(generate(cmdlu))
	} catch (err) {
		console.error(
			"For the help, you need the optional dependencies.\n" +
				"Install them by executing 'npm i --include=optional' in the folder of the debugger"
		);
	}
	process.exit(0);
}

// Parse arguments
const silentLvl = Number(args?.values?.silent ?? 0);
if (Number.isNaN(silentLvl))
	throw new Error('The option "silent" should be a number.');
if (silentLvl > 2 || silentLvl < 0)
	throw new Error('The option "silent" should in range 0-2.');

const wssPort = Number(args?.values?.port ?? 9090);
if (Number.isNaN(wssPort))
	throw new Error('The option "port" should be a number.');

const onConnectedPath = args?.values?.onConnectedPath;
let onConnectedCode = undefined;
if (typeof onConnectedPath !== "undefined" && onConnectedPath !== "") {
	await fs.access(onConnectedPath, fs.constants.R_OK).catch((e) => {
		console.log(`The path in "onConnectedPath" is not accessible`);
		console.error(e);
		process.exit(e.errno);
	});
	onConnectedCode = await fs.readFile(onConnectedPath, "utf-8");
	if (onConnectedCode === "") debuggerWarning(`The file in "onConnectedPath" is empty`);
}

// Utility functions for more visually pleasing logs
// Get out of user input area first if prompt is currently being shown
function colorise(message, source, color) {
	return color(`[${source}] `) + message;
}
function safeLog(data) {
	console.log((isPrompting ? "\n" : "") + data);
}

function discordColorise(data) {
	let { message, level } = JSON.parse(data);
	// Normal logs don't need extra colorization
	switch (level) {
		case 0: // Info
			message = COLORS.client.info(message);
			break;
		case 2: // Warning
			message = COLORS.client.warning(message);
			break;
		case 3: // Error
			message = COLORS.client.error(message);
			break;
	}
	return colorise(message, "Vendetta", COLORS.client.info);
}
function discordLog(message) {
	return safeLog(silentLvl === 2 ? message : discordColorise(message));
}

function debuggerColorise(message) {
	return colorise(message, "Debugger", COLORS.debugger.info);
}
function debuggerLog(message) {
	safeLog(silentLvl === 2 ? messag : debuggerColorise(message));
}
function debuggerWarning(message) {
	safeLog(colorise(message, "Debugger", COLORS.debugger.warning));
}
function debuggerError(error, isReturning) {
	safeLog(colorise("Error", "Debugger", COLORS.debugger.error));
	if (isReturning) {
		return error;
	}
	console.error(error);
}

// Display welcome message and basic instructions
if (silentLvl < 1)
	console.log(
		"Welcome to the unofficial Vendetta debugger.\n" +
			"Press Ctrl+C to exit.\n" +
			"How to connect to the debugger: https://github.com/Meqativ/vendetta-debug/blob/master/README.md#connecting"
	);

// Create websocket server and REPL, and wait for connection
const wss = new WebSocketServer({ port: wssPort });
wss.on("listening", (ws) => {
	if (silentLvl < 2)
		debuggerLog(`Listening for connections on port ${wss.address().port}`);
});
wss.on("connection", (ws) => {
	if (silentLvl < 2)
		debuggerLog("Connected to Discord over websocket, starting debug session");

	isPrompting = false; // REPL hasn't been created yet
	let finishCallback;

	// Handle logs returned from Discord client via the websocket
	ws.on("message", (data) => {
		try {
			if (finishCallback) {
				finishCallback(null, data);
				finishCallback = undefined;
			} else {
				discordLog(data);
			}
		} catch (e) {
			debuggerError(e, false);
		}
		isPrompting = true;
		rl.displayPrompt();
	});

	// Create the REPL
	const rl = repl.start({
		eval: (input, ctx, filename, cb) => {
			try {
				if (!input.trim()) {
					cb();
				} else {
					isPrompting = false;
					ws.send(
						`const res=(0, eval)(${JSON.stringify(
							input
						)});let out=vendetta.metro.findByProps("inspect").inspect(res,{showHidden:true});if(out!=="undefined")console.log(out);res`
					); // Logs out the returned value
					finishCallback = cb;
				}
			} catch (e) {
				cb(e);
			}
		},
		writer: (data) => {
			return data instanceof Error
				? debuggerError(data, true)
				: discordColorise(data);
		},
	});
	isPrompting = true; // Now the REPL exists and is prompting the user for input

	rl.on("close", () => {
		if (silentLvl < 2) debuggerLog("Closing debugger, press Ctrl+C to exit");
	});

	ws.on("close", () => {
		if (silentLvl < 2) debuggerLog("Websocket has been closed");
		isPrompting = false;
		rl.close();
	});
	if (onConnectedCode) ws.send(onConnectedCode);
});
