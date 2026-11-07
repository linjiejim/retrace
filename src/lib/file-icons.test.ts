import { describe, expect, it } from "vitest"
import { fileType, folderType } from "./file-icons"

describe("file icons", () => {
  it("knows files by name before extension", () => {
    expect(fileType("package.json").kind).toBe("package")
    expect(fileType("web/pnpm-lock.yaml").kind).toBe("lock")
    expect(fileType("README.md").kind).toBe("readme")
    expect(fileType("LICENSE").kind).toBe("license")
    expect(fileType("Dockerfile").kind).toBe("docker")
    expect(fileType(".env.local").kind).toBe("env")
    expect(fileType("src/lib/tree.test.ts").kind).toBe("test")
    expect(fileType("vite.config.ts").kind).toBe("config")
  })

  it("falls back to the extension, then to a plain file", () => {
    expect(fileType("src/App.tsx")).toEqual({ kind: "react", tone: "primary", letters: "TX" })
    expect(fileType("a/b.RS").letters).toBe("RS")
    expect(fileType("Makefile.am")).toEqual({ kind: "file", tone: "faint", letters: "" })
    expect(fileType(".hidden").kind).toBe("file")
  })

  it("reads the last part of a joined folder chain", () => {
    expect(folderType("packages/web/src").kind).toBe("code")
    expect(folderType("node_modules").kind).toBe("deps")
    expect(folderType("whatever").kind).toBe("folder")
  })
})
