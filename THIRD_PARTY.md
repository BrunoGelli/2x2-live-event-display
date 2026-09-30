# Third-party components

Plotly.js is MIT-licensed, copyright Plotly, Inc. The optional `live2x2 assets`
installation downloads the versioned official bundle and preserves its license header.
The generated asset is excluded from git, but is included in a built wheel/container
when downloaded before packaging. No fonts or detector data are bundled.

Worker code depends on, and imports rather than copies, BrunoGelli/UCD_2x2_Analysis_Framework
at commit 0400d9b788d4515bee9a22b230df08937475d0ef for FLOW reference resolution and
nominal detector geometry. See that repository for its source and applicable terms.
