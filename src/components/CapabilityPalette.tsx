import { For } from "solid-js";
import {
  capabilityReadiness,
  capabilityStatusLabel,
  STUDIO_CAPABILITIES,
  type StudioCapability,
} from "../capabilities";
import type { CapabilityCatalog } from "../protocol";

interface Props {
  catalog: CapabilityCatalog;
  onClose: () => void;
  onLaunch: (capability: StudioCapability) => void;
}

export function CapabilityPalette(props: Props) {
  return (
    <div class="modal-backdrop capability-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="capability-palette" aria-label="Machine capabilities">
        <header class="capability-heading">
          <div>
            <div class="eyebrow">MACHINE LIBRARY</div>
            <h2>What should Amplifier become?</h2>
            <p>Choose an outcome. Studio composes the runtime and opens it beside your coordinator.</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close capabilities" onClick={props.onClose}>×</button>
        </header>

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
                  <small>{capability.requirements}</small>
                  <button class="secondary-button" onClick={() => props.onLaunch(capability)}>{capability.action}</button>
                </footer>
              </article>
            );
          }}</For>
        </div>

        <div class="capability-footnote">
          <strong>Active-session Autopilot</strong>
          <span>Autopilot directs the coordinator already open. Desktop control is a capability mounted into that runtime, not a separate coordinator session.</span>
        </div>
      </section>
    </div>
  );
}
