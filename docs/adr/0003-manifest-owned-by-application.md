# The manifest is declared by the application, not the library

The `Syn_Visu` library provides the manifest's type and the component function blocks, but each application project declares the manifest instance itself at the fixed symbol `GVL_Visu.stManifest`. How TwinCAT names a library's global variables in the ADS symbol table, with or without the library namespace, could not be pinned down. Discovery depends on one fixed path, so we keep that path in the application, where its name is certain.

## Consequences

- Every application needs a one-line `GVL_Visu` declaring `stManifest : Syn_Visu.ST_VisuManifest`.
- For the same reason, the gateway accepts interface type names with or without a namespace prefix, e.g. `Syn_Visu.ST_VisuDelta`.
