import { For, Show } from "solid-js";
import {
  capabilityReadiness,
  capabilityStatusLabel,
  STUDIO_CAPABILITIES,
  type StudioCapability,
} from "../capabilities";
import type { CapabilityCatalog } from "../protocol";

interface Props {
  catalog: CapabilityCatalog;
  catalogError?: string;
  onClose: () => void;
  onLaunch: (capability: StudioCapability) => void;
}

export function CapabilityPalette(props: Props) {
  return (
    <div class="modal-backdrop capability-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="capability-palette" aria-label="Session capabilities">
        <header class="capability-heading">
          <div>
            <div class="eyebrow">CAPABILITY LIBRARY</div>
            <h2>What should Amplifier become?</h2>
            <p>Choose an outcome. Studio composes the runtime and opens it beside your coordinator.</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close capabilities" onClick={props.onClose}>×</button>
        </header>

        <Show when={props.catalogError} keyed>{(message) => (
          <div class="catalog-discovery-warning" role="status">
            Amplifier's installed-bundle catalog could not be read: {message}. Pinned capabilities can still be fetched when launched.
          </div>
        )}</Show>

        <div class="capability-grid">
          <For each={STUDIO_CAPABILITIES}>{(capability) => {
            const readiness = capabilityReadiness(capability, props.catalog);
            return (
              <article class={`capability-card ${capability.accent}`}>
                <div class="capability-card-top">
                  <span>{capability.eyebrow}</span>
                  <small>{capabilityStatusLabel(readiness)}</small>
                </div>
                <h3>{capability.name}</h3>
                <strong>{capability.outcome}</strong>
                <p>{capability.description}</p>
                <footer>
                  <ul class="capability-requirements">
                    <For each={capability.requirements}>{(requirement) => <li>{requirement}</li>}</For>
                  </ul>
                  <Show
                    when={capability.activation === "parallel-session"}
                    fallback={<span class="capability-included-status">{capability.action}</span>}
                  >
                    <button class="secondary-button" onClick={() => props.onLaunch(capability)}>{capability.action}</button>
                  </Show>
                </footer>
              </article>
            );
          }}</For>
        </div>

        <div class="capability-footnote">
          <strong>Active-session Autopilot</strong>
          <span>Autopilot and terminal tools operate the coordinator already open. New tabs are reserved for genuinely independent runtimes that can execute in parallel.</span>
        </div>
      </section>
    </div>
  );
}
