// Polyfills for Node.js modules in the browser
import { Buffer } from 'buffer';
import process from 'process';

// Make Buffer and process available globally
(window as any).global = window;
(window as any).Buffer = Buffer;
(window as any).process = process;

// Set process.env if not defined
if (!process.env) {
	process.env = {};
}

export { };
