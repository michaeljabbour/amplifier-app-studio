import { describe, expect, it } from "vitest";
import { discoverOutputArtifacts, outputToolFailed } from "./outputDiscovery";
import type { UIEvent } from "./protocol";

const post = (fields: Record<string, unknown>): UIEvent => ({ kind: "tool_post", tool_name: "bash", ...fields });

describe("output discovery evidence", () => {
  it("does not list directory creation results or slash-terminated artifacts as files", () => {
    for (const tool_name of ["create_directory", "create_folder", "mkdir"]) {
      expect(discoverOutputArtifacts(post({ tool_name, result: { success: true, path: "reports" } }))).toEqual([]);
    }
    expect(discoverOutputArtifacts(post({ result: { artifacts: [{ path: "reports/" }, { path: "reports", kind: "directory" }] } }))).toEqual([]);
  });

  it("understands Amplifier ToolResult and amplifier-agent JSON value envelopes", () => {
    const output = { success: true, error: null, output: { file_path: "reports/analysis.html" } };
    for (const result of [output, { value: JSON.stringify(output) }, { content: [{ type: "text", text: JSON.stringify(output) }] }]) {
      expect(discoverOutputArtifacts(post({ tool_name: "write_file", result }))).toEqual([
        { path: "reports/analysis.html", kind: "file", provenance: "tool-artifact" },
      ]);
    }
  });

  it("uses explicit artifact collections from shell, delegates and other producers", () => {
    for (const tool_name of ["bash", "delegate", "amplifier_agent"]) {
      expect(discoverOutputArtifacts(post({ tool_name, result: { success: true, output: {
        artifacts: [{ path: "reports/chart.png", kind: "image" }],
      } } }))).toEqual([{ path: "reports/chart.png", kind: "image", provenance: "tool-artifact" }]);
    }
  });

  it("does not turn read artifacts, input echoes, source excerpts or directories into outputs", () => {
    // Real 8a1289f6 history included 213 read_file artifacts and a numbered
    // PROVENANCE excerpt saying 'wrote packet_rav-1.html'; neither is a write.
    for (const tool_name of ["read_file", "web_fetch", "mcp__filesystem__read_file", "search"]) {
      expect(discoverOutputArtifacts(post({ tool_name, artifacts: [{ path: "/project/input.html" }],
        result: { success: true, output: { file_path: "/project/input.html" } } }))).toEqual([]);
    }
    expect(discoverOutputArtifacts(post({ tool_input: { path: "/project/input.html" }, result: {
      success: true, output: { returncode: 0, path: "/project/input.html",
        stdout: "  7202\t  wrote packet_rav-1.html  (30 items)\ncreated /tmp/packet-forensic-final.CE7m7q/chain\nSee [input](input.html)\ncat reports/report.html" },
    } }))).toEqual([]);
  });

  it("labels successful shell creation reports without claiming filesystem verification", () => {
    expect(discoverOutputArtifacts(post({ result: { success: true, output: { returncode: 0,
      stdout: "wrote reports/report.html (30 items)\nSaved to `reports/chart with spaces.png`\nCreated [data](reports/data.csv)\nReading inputs/source.md",
    } } }))).toEqual([
      { path: "reports/report.html", kind: "file", provenance: "tool-report" },
      { path: "reports/chart with spaces.png", kind: "image", provenance: "tool-report" },
      { path: "reports/data.csv", kind: "data", provenance: "tool-report" },
    ]);
    expect(discoverOutputArtifacts(post({ result: { stdout: "wrote report.html" } }))).toEqual([]);
  });

  it("never promotes a failed or denied write target, including nested result failures", () => {
    const failures = [
      { success: false, output: { path: "report.html" } },
      { value: JSON.stringify({ success: false, error: "denied" }) },
      { content: [{ type: "text", text: JSON.stringify({ isError: true }) }] },
      { success: true, output: { returncode: 1, stdout: "wrote report.html" } },
    ];
    for (const result of failures) {
      const event = post({ tool_name: "write_file", tool_input: { path: "report.html" }, result });
      expect(outputToolFailed(event)).toBe(true);
      expect(discoverOutputArtifacts(event)).toEqual([]);
    }
  });

  it("keeps render input paths separate from explicit output destinations", () => {
    expect(discoverOutputArtifacts(post({ tool_name: "render", tool_input: {
      path: "input.html", output_path: "rendered.png",
    }, result: { success: true } }))).toEqual([{ path: "rendered.png", kind: "image", provenance: "write-target" }]);
    expect(discoverOutputArtifacts(post({ tool_name: "write_file", tool_input: { path: "README" },
      artifacts: [{ path: "README", kind: "file" }], result: { success: true } }))).toEqual([
      { path: "README", kind: "file", provenance: "tool-artifact" },
    ]);
  });
});
