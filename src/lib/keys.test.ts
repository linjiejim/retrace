import { expect, it } from "vitest"
import { isImeKey } from "./keys"

const key = (isComposing: boolean, keyCode: number) => ({ isComposing, keyCode })

it("takes a key typed while an input method composes as the input method's", () => {
  expect(isImeKey(key(true, 13))).toBe(true)
  expect(isImeKey(key(true, 229))).toBe(true)
})

it("knows WebKit's Enter or Esc that ends the composition by its key code alone", () => {
  // compositionend has already fired, so isComposing is false.
  expect(isImeKey(key(false, 229))).toBe(true)
})

it("leaves plain Enter and Esc alone", () => {
  expect(isImeKey(key(false, 13))).toBe(false)
  expect(isImeKey(key(false, 27))).toBe(false)
})
