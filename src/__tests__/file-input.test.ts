import { describe, it, expect } from "vitest";
import { takeFilesFromInput } from "../utils";

/**
 * Attaching reported "Attached 0 file(s), 0 KB, encrypted" and produced
 * nothing, for a file the user had definitely chosen.
 *
 * `input.files` is a live FileList bound to the element. The handler cleared
 * `input.value` first -- necessary so that picking the same file twice still
 * fires `change` -- which empties that FileList in place, and then read a
 * length of zero.
 *
 * WHY THE DOUBLE. jsdom does not model this: with `files` defined on the
 * element, clearing `value` leaves the list untouched, so a test driving a
 * real input through jsdom passes against the broken code and proves nothing.
 * Measured, not assumed -- before writing this, an input was built in jsdom
 * and `files.length` was still 1 after the reset.
 *
 * So the double below implements the browser's actual contract, and only that.
 * If it ever stops failing against a value-first implementation, it has stopped
 * testing anything.
 */

/** A file input that behaves the way a browser does: reset clears the list. */
function browserLikeInput(files: File[]): HTMLInputElement {
  let cleared = false;
  return {
    get files() {
      return cleared ? ([] as unknown as FileList) : (files as unknown as FileList);
    },
    get value() {
      return cleared ? "" : "C:\\fakepath\\" + (files[0]?.name ?? "");
    },
    set value(v: string) {
      if (v === "") cleared = true;
    },
  } as unknown as HTMLInputElement;
}

const file = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" });

describe("taking files off a file input", () => {
  it("returns the picked file rather than losing it to the reset", () => {
    const input = browserLikeInput([file("notes.txt")]);
    const got = takeFilesFromInput(input);
    expect(got.map((f) => f.name)).toEqual(["notes.txt"]);
  });

  it("returns every file when several were picked", () => {
    const input = browserLikeInput([file("a.txt"), file("b.png"), file("c.pdf")]);
    expect(takeFilesFromInput(input).map((f) => f.name)).toEqual(["a.txt", "b.png", "c.pdf"]);
  });

  it("still resets the input, so the same file can be picked twice", () => {
    // The reason the reset is there at all. Without it, choosing the same file
    // again fires no change event and nothing happens.
    const input = browserLikeInput([file("same.txt")]);
    takeFilesFromInput(input);
    expect(input.value).toBe("");
  });

  it("returns an empty list when the picker was cancelled", () => {
    expect(takeFilesFromInput(browserLikeInput([]))).toEqual([]);
  });

  it("survives an input with no files property at all", () => {
    const input = { files: null, value: "" } as unknown as HTMLInputElement;
    expect(takeFilesFromInput(input)).toEqual([]);
  });

  it("hands back a real array, detached from the element", () => {
    // The returned value must survive the element being reset again later --
    // it is iterated asynchronously while uploads run.
    const input = browserLikeInput([file("keep.txt")]);
    const got = takeFilesFromInput(input);
    input.value = "";
    expect(got).toHaveLength(1);
    expect(Array.isArray(got)).toBe(true);
  });
});

describe("the double itself is honest", () => {
  it("models the browser: reading files after a reset gives nothing", () => {
    // If this ever fails, the double has stopped reproducing the bug and every
    // test above becomes meaningless.
    const input = browserLikeInput([file("x.txt")]);
    input.value = "";
    expect(Array.from(input.files ?? [])).toEqual([]);
  });

  it("would catch the original ordering mistake", () => {
    const input = browserLikeInput([file("x.txt")]);
    // The old implementation, verbatim: clear first, read second.
    input.value = "";
    const filesAfter = Array.from(input.files ?? []);
    expect(filesAfter).toHaveLength(0); // <- this was the bug
  });
});
