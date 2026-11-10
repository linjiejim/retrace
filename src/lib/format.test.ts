import { afterEach, describe, expect, it } from "vitest"
import { duration } from "./format"
import { lang, setLang } from "./i18n"

const initial = lang()
afterEach(() => setLang(initial))

describe("duration", () => {
  it("reads in seconds, minutes and hours", () => {
    setLang("en")
    expect([duration(38), duration(98), duration(3720), duration(-1)]).toEqual(["38s", "1m 38s", "1h 2m", "0s"])
    setLang("zh")
    expect([duration(38), duration(98), duration(3720)]).toEqual(["38 秒", "1 分 38 秒", "1 小时 2 分"])
  })
})
