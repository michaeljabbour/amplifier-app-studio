/** Types for the CSP-hash helper so the VisualArtifact regression test can import it. */
export declare const ARTIFACT_SOURCE: string;
export declare const TAURI_CONF: string;
export declare function readArtifactResizeScript(source?: string): string;
export declare function artifactScriptHash(script?: string): string;
export declare function cspWithArtifactHash(csp: string, hash: string): string;
