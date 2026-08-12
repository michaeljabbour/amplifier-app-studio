import { For, Show } from "solid-js";
import { attachmentKindLabel, formatAttachmentBytes } from "../attachments";
import type { ComposerAttachment } from "../protocol";

interface Props {
  attachments: ComposerAttachment[];
  onRemove?: (id: string) => void;
  transcript?: boolean;
}

export function AttachmentStrip(props: Props) {
  return (
    <div
      class="attachment-strip"
      classList={{ "transcript-attachments": props.transcript }}
      aria-label={props.transcript ? "Prompt attachments" : "Attached files"}
    >
      <For each={props.attachments}>{(attachment) => (
        <div class="attachment-chip" classList={{ document: attachment.kind === "document" }}>
          <Show
            when={attachment.kind === "image"}
            fallback={<span class="attachment-file-kind" aria-hidden="true">{attachmentKindLabel(attachment)}</span>}
          >
            <img
              src={`data:${attachment.kind === "image" ? attachment.mediaType : ""};base64,${attachment.kind === "image" ? attachment.data : ""}`}
              alt=""
            />
          </Show>
          <span class="attachment-chip-copy">
            <strong>{attachment.name}</strong>
            <small>
              {formatAttachmentBytes(attachment.size)}
              {attachment.kind === "document" ? ` · ${attachment.text.length.toLocaleString()} chars${attachment.truncated ? " · truncated" : ""}` : ""}
            </small>
          </span>
          <Show when={props.onRemove}>{(remove) => (
            <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => remove()(attachment.id)}>×</button>
          )}</Show>
        </div>
      )}</For>
    </div>
  );
}
