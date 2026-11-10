// jade/custom-commands：Markdown 文件变成斜杠命令。

import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { fill, parseCommand } from "../plugins/custom-commands/index.ts";
import { cleanup, scriptedHost } from "./scripted-ui.ts";

afterEach(cleanup);

describe("jade/custom-commands", () => {
  test("parseCommand reads the description; fill puts the arguments in", () => {
    expect(parseCommand("---\ndescription: \"review it\"\n---\nReview $ARGUMENTS now\n")).toEqual({ description: "review it", body: "Review $ARGUMENTS now" });
    expect(parseCommand("just text\n")).toEqual({ body: "just text" });
    expect(fill("Review $ARGUMENTS now", " the diff ")).toBe("Review the diff now");
    expect(fill("Review it", "carefully")).toBe("Review it\n\ncarefully");
    expect(fill("Review it", "")).toBe("Review it");
  });

  test("a markdown file under $JADE_HOME/commands is a slash command that sends its content", async () => {
    const { home, host } = await scriptedHost({
      files: {
        "commands/review.md": "---\ndescription: review the changes\n---\nReview $ARGUMENTS and list the problems.\n",
        // 名字已经被 jade/sessions 占用：不登记，原来的命令不受影响
        "commands/clear.md": "not this\n",
      },
    });
    const commands = host.service<Commands>("commands@1")!;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const review = commands.get("review")!;
    expect(review.plugin).toBe("jade/custom-commands");
    expect(commands.list().find((x) => x.name === "review")!.description).toBe("review the changes (user command)");
    expect(await review.command.run("the staged diff", c)).toEqual({ prompt: "Review the staged diff and list the problems." });
    // 文件改了马上生效
    await writeFile(path.join(home, "commands", "review.md"), "Look at $ARGUMENTS.\n");
    expect(await review.command.run("x", c)).toEqual({ prompt: "Look at x." });
    expect(commands.get("clear")!.plugin).toBe("jade/sessions");
  });
});
