// Single source of the app version for "What's New" surfaces and diagnostics.
// Derived from package.json so the two can never drift.
import { version } from "../package.json"

export const APP_VERSION: string = version
