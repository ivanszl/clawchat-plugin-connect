import { spawn } from "node:child_process";
import type { WorkBuddyProfileCompatibility } from "../../src/runtime/workbuddy-task-discovery";

interface NativeUiVerificationInput {
  compatibility: WorkBuddyProfileCompatibility;
  taskTitle: string;
  marker: string;
  restoreTaskTitle: string;
}

export async function verifyInstalledWorkBuddyNativeUi(input: NativeUiVerificationInput): Promise<void> {
  await runCommand(
    "/usr/bin/osascript",
    ["-e", `tell application id "${input.compatibility.bundleIdentifier}" to quit`],
    15_000,
  );
  await waitForApplicationProcess(input.compatibility.applicationPath, false);
  await runCommand("/usr/bin/open", [input.compatibility.applicationPath], 15_000);
  const processId = await waitForApplicationProcess(input.compatibility.applicationPath, true);
  try {
    await runCommand(
      "/usr/bin/osascript",
      ["-e", WORKBUDDY_UI_MARKER_SCRIPT, "--", String(processId), input.taskTitle, input.marker],
      120_000,
    );
  } finally {
    await runCommand(
      "/usr/bin/osascript",
      ["-e", WORKBUDDY_UI_RESTORE_SCRIPT, "--", String(processId), input.restoreTaskTitle],
      60_000,
    );
  }
}

export async function selectInstalledWorkBuddyNativeTask(
  compatibility: WorkBuddyProfileCompatibility,
  taskTitle: string,
): Promise<void> {
  const processId = await waitForApplicationProcess(compatibility.applicationPath, true);
  await runCommand(
    "/usr/bin/osascript",
    ["-e", WORKBUDDY_UI_RESTORE_SCRIPT, "--", String(processId), taskTitle],
    60_000,
  );
}

async function waitForApplicationProcess(applicationPath: string, expectedRunning: boolean): Promise<number> {
  const executable = `${applicationPath}/Contents/MacOS/Electron`;
  const deadline = Date.now() + 30_000;
  do {
    const processId = await readApplicationProcessId(executable);
    if (expectedRunning ? processId !== null : processId === null) return processId ?? 0;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    `${expectedRunning ? "Timed out opening" : "Timed out closing"} the native WorkBuddy application process`,
  );
}

async function readApplicationProcessId(executable: string): Promise<number | null> {
  const output = await runCommand("/bin/ps", ["-axo", "pid=,ppid=,comm="], 5_000);
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (match?.[2] === "1" && match[3]?.trim() === executable) return Number(match[1]);
  }
  return null;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim() || "no diagnostic"}`));
    });
  });
}

const WORKBUDDY_UI_MARKER_SCRIPT = `
on elementContains(candidate, expectedText)
  try
    if (name of candidate as text) contains expectedText then return true
  end try
  try
    if (description of candidate as text) contains expectedText then return true
  end try
  try
    if (value of candidate as text) contains expectedText then return true
  end try
  return false
end elementContains

on selectedTaskContainsMarker(targetProcess, taskTitle, marker)
  tell application "System Events"
    tell targetProcess
      if (count of windows) is 0 then return false
      set candidates to entire contents of front window
      repeat with candidate in candidates
        try
          if (role of candidate is "AXStaticText") and (name of candidate as text is taskTitle) then
            set taskRegion to value of attribute "AXParent" of candidate
            set taskContents to entire contents of taskRegion
            repeat with taskElement in taskContents
              if my elementContains(taskElement, marker) then return true
            end repeat
          end if
        end try
      end repeat
    end tell
  end tell
  return false
end selectedTaskContainsMarker

on openTask(targetProcess, taskTitle)
  tell application "System Events"
    tell targetProcess
      if (count of windows) is 0 then return false
      set candidates to entire contents of front window
      repeat with candidate in candidates
        try
          set candidateRole to role of candidate
        on error
          set candidateRole to ""
        end try
        if candidateRole is "AXButton" and my elementContains(candidate, taskTitle) then
          try
            perform action "AXPress" of candidate
            return true
          end try
          try
            click candidate
            return true
          end try
        end if
      end repeat
    end tell
  end tell
  return false
end openTask

on run argv
  set targetPid to (item 1 of argv) as integer
  set taskTitle to item 2 of argv
  set marker to item 3 of argv
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
  end tell
  set taskOpened to false
  repeat 30 times
    if my openTask(targetProcess, taskTitle) then
      set taskOpened to true
      exit repeat
    end if
    delay 1
  end repeat
  if not taskOpened then error "The dedicated WorkBuddy Task was not visible after reopening the application"
  repeat 30 times
    if my selectedTaskContainsMarker(targetProcess, taskTitle, marker) then return "visible"
    delay 1
  end repeat
  error "The synchronized marker did not appear in the reopened native WorkBuddy Task"
end run
`;

const WORKBUDDY_UI_RESTORE_SCRIPT = `
on elementContains(candidate, expectedText)
  try
    if (name of candidate as text) contains expectedText then return true
  end try
  try
    if (description of candidate as text) contains expectedText then return true
  end try
  try
    if (value of candidate as text) contains expectedText then return true
  end try
  return false
end elementContains

on run argv
  set targetPid to (item 1 of argv) as integer
  set taskTitle to item 2 of argv
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    tell targetProcess
      repeat 30 times
        if (count of windows) is greater than 0 then
          set candidates to entire contents of front window
          repeat with candidate in candidates
            try
              if (role of candidate is "AXButton") and my elementContains(candidate, taskTitle) then
                try
                  perform action "AXPress" of candidate
                  return "restored"
                end try
                try
                  click candidate
                  return "restored"
                end try
              end if
            end try
          end repeat
        end if
        delay 1
      end repeat
    end tell
  end tell
  error "The prior WorkBuddy application view could not be restored"
end run
`;
