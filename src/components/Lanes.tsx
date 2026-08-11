import { For, Show } from "solid-js";
import type { LaneState } from "../protocol";
import { Markdown } from "./Markdown";

export function Lanes(props: { lanes: LaneState[] }) {
  return (
    <section class="lanes-panel" aria-label="Delegate lanes">
      <div class="lanes-heading"><span>PARALLEL WORK</span><strong>{props.lanes.length}</strong></div>
      <For each={props.lanes}>
        {(lane) => (
          <div class={`lane-row ${lane.status}`}>
            <span class="lane-state">{lane.status === "running" ? "✳" : lane.status === "completed" ? "✓" : "!"}</span>
            <div>
              <strong>{lane.agent}</strong>
              <span class="lane-activity">{lane.activity}</span>
              <Show when={lane.tools.length > 0}>
                <div class="lane-tools">
                  <For each={lane.tools.slice(-4)}>{(tool) => (
                    <div class={tool.status}>
                      <i>{tool.status === "running" ? "◌" : tool.status === "completed" ? "✓" : "!"}</i>
                      <code>{tool.label}</code>
                    </div>
                  )}</For>
                </div>
              </Show>
              <Show when={lane.thinking}>
                <details class="lane-thinking">
                  <summary>◇ Thinking</summary>
                  <Markdown compact text={lane.thinking} />
                </details>
              </Show>
              <Show when={lane.tail && lane.tailKind === "thinking"}>
                <details class="lane-thinking" open>
                  <summary>◇ Thinking · live</summary>
                  <Markdown compact text={lane.tail} />
                </details>
              </Show>
              <Show when={lane.tail && lane.tailKind === "text"}><Markdown compact text={lane.tail} /></Show>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}
