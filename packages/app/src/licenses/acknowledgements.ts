// Third-party acknowledgements for the Licenses/Acknowledgements screen (notices live there,
// never as branding). Entries are plain text; the screen renders them
// as-is. An entry that ships third-party code must carry that code's licence text; a
// courtesy credit, such as Archify below, carries none because no Archify code ships.

export interface Acknowledgement {
  id: string;
  name: string;
  line: string;
  licence: string;
  shipsThirdPartyCode: boolean;
}

export const ACKNOWLEDGEMENTS: readonly Acknowledgement[] = [
  {
    id: "archify",
    name: "Archify",
    line: "Architecture maps read the Archify Architecture IR v1 format (tt-a1i/archify, MIT); Fulcra's map renderer contains no Archify code.",
    licence: "MIT",
    shipsThirdPartyCode: false,
  },
];
