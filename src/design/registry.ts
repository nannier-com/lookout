/**
 * The kits lookout knows by name.
 *
 * Detection is deliberately a table rather than a heuristic. A design system is
 * a fact about a repository, not a judgement call, and a fact is something a
 * person should be able to read, correct, and add to without understanding the
 * scanner. Everything clever lives in `detect.ts`; this file is data.
 *
 * A kit earns an entry when its presence is decidable from a manifest: a
 * dependency name, or a file only that kit puts there. Kits that leave neither
 * (an in-house component library with no distinguishing marks) are found by the
 * workspace scan instead, or declared in config. Guessing is not a third
 * option: naming the wrong kit would send every fix to the wrong repository.
 */

/** How confident detection is allowed to be about one signal. */
export type SignalStrength = "declared" | "dependency" | "marker" | "inferred";

export interface KnownKit {
  /** Stable handle used in the inventory and in issue documents. */
  id: string;
  /** What a person calls it. */
  name: string;
  /**
   * Package names that mean this kit is installed. Any one is enough; a kit
   * split across several packages lists them all, because an app that pulls
   * only `@mui/material` is as much an MUI app as one that also pulls the lab.
   */
  packages: string[];
  /**
   * Files whose mere existence names the kit, for kits that are vendored into
   * the repository rather than installed. Relative to the project root.
   */
  markers?: string[];
  /**
   * Where this kit's own components live once vendored, relative to the project
   * root. Only meaningful for vendored kits: an installed one lives in
   * node_modules and is not the repository's to edit.
   */
  vendoredAt?: string[];
  /**
   * Import specifier prefixes that mean "this came from the kit". Defaults to
   * the package names when absent.
   */
  importPrefixes?: string[];
  /** Where the kit documents itself, for the issue document to point at. */
  docs?: string;
}

/**
 * Ordered by specificity, not popularity: the first match wins, so a kit built
 * on top of another (shadcn on Radix, Canvas on nothing) must be listed before
 * the primitive it is built from, or every shadcn app would be reported as a
 * Radix app and fixes would be aimed at a dependency nobody edits.
 */
export const KNOWN_KITS: KnownKit[] = [
  {
    id: "canvas",
    name: "Canvas",
    packages: ["@nannier-com/canvas", "@nannier/canvas"],
    importPrefixes: ["@nannier-com/canvas", "@nannier/canvas"],
  },
  {
    id: "shadcn",
    name: "shadcn/ui",
    // Vendored, not installed: the dependency list never names it, and the
    // components are the repository's own files. That is the whole reason it
    // needs markers, and the reason a shadcn defect is fixed in the app repo
    // rather than upstream.
    packages: [],
    markers: ["components.json"],
    vendoredAt: [
      "components/ui",
      "src/components/ui",
      "app/components/ui",
      "resources/js/components/ui",
    ],
    importPrefixes: ["@/components/ui", "~/components/ui"],
    docs: "https://ui.shadcn.com",
  },
  {
    id: "mui",
    name: "MUI",
    packages: ["@mui/material", "@mui/joy", "@mui/base"],
    importPrefixes: ["@mui/"],
  },
  {
    id: "chakra",
    name: "Chakra UI",
    packages: ["@chakra-ui/react"],
    importPrefixes: ["@chakra-ui/"],
  },
  {
    id: "mantine",
    name: "Mantine",
    packages: ["@mantine/core"],
    importPrefixes: ["@mantine/"],
  },
  {
    id: "antd",
    name: "Ant Design",
    packages: ["antd"],
    importPrefixes: ["antd"],
  },
  {
    id: "polaris",
    name: "Shopify Polaris",
    packages: ["@shopify/polaris"],
    importPrefixes: ["@shopify/polaris"],
  },
  {
    id: "carbon",
    name: "Carbon",
    packages: ["@carbon/react", "carbon-components-react"],
    importPrefixes: ["@carbon/", "carbon-components-react"],
  },
  {
    id: "fluent",
    name: "Fluent UI",
    packages: ["@fluentui/react", "@fluentui/react-components"],
    importPrefixes: ["@fluentui/"],
  },
  {
    id: "spectrum",
    name: "React Spectrum",
    packages: ["@adobe/react-spectrum"],
    importPrefixes: ["@adobe/react-spectrum", "@react-spectrum/"],
  },
  {
    id: "paper",
    name: "React Native Paper",
    packages: ["react-native-paper"],
    importPrefixes: ["react-native-paper"],
  },
  {
    id: "ionic",
    name: "Ionic",
    packages: ["@ionic/react", "@ionic/vue", "@ionic/angular"],
    importPrefixes: ["@ionic/"],
  },
  {
    id: "vuetify",
    name: "Vuetify",
    packages: ["vuetify"],
    importPrefixes: ["vuetify"],
  },
  {
    id: "primevue",
    name: "PrimeVue",
    packages: ["primevue", "primereact"],
    importPrefixes: ["primevue", "primereact"],
  },
  {
    id: "quasar",
    name: "Quasar",
    packages: ["quasar"],
    importPrefixes: ["quasar"],
  },
  {
    // Last: Radix is a primitive layer many kits are built on, so it names a
    // design system only when nothing above it matched.
    id: "radix",
    name: "Radix UI",
    packages: ["@radix-ui/react-dialog", "@radix-ui/themes", "@radix-ui/react-dropdown-menu"],
    importPrefixes: ["@radix-ui/"],
  },
];

/**
 * Token layers, which are not component kits but still decide where a colour or
 * a spacing fix belongs. A project can have one, the other, or both, and the
 * distinction matters: a contrast defect in a Tailwind app is usually a token
 * edit, not a component edit.
 */
export const TOKEN_MARKERS = [
  { id: "tailwind", name: "Tailwind CSS", files: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"] },
  { id: "panda", name: "Panda CSS", files: ["panda.config.ts", "panda.config.js"] },
  { id: "unocss", name: "UnoCSS", files: ["uno.config.ts", "unocss.config.ts"] },
  { id: "stylex", name: "StyleX", files: [".stylexrc.json", ".stylexrc.js"] },
  // "config.json" is deliberately NOT a marker here: Style Dictionary's
  // default config name is generic enough to sit in half the repositories on
  // disk, and a token layer named by mistake sends colour fixes somewhere no
  // token lives.
  { id: "style-dictionary", name: "Style Dictionary", files: ["style-dictionary.config.js", "style-dictionary.config.json", "sd.config.js"] },
] as const;
