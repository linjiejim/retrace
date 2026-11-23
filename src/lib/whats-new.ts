// What changed in each version: the toast after an update, its dialog and Settings › Updates.
// The notes are the repository's CHANGELOG.md and CHANGELOG.zh-CN.md, bundled at build time, so
// a new version carries its own notes and reading them needs no network.

import en from "../../CHANGELOG.md?raw"
import zh from "../../CHANGELOG.zh-CN.md?raw"
import { parseChangelog, type Release } from "./changelog"
import { lang } from "./i18n"

/** Every version with its notes and downloads. */
export const RELEASES_URL = "https://github.com/linjiejim/retrace/releases"

const RELEASES = { en: parseChangelog(en), zh: parseChangelog(zh) }

/** The release notes in the UI language, newest first. */
export const releases = (): Release[] => RELEASES[lang()]
