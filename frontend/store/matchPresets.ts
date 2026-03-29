import { MatchConfig } from "./matchConfig";

const UZBEKISTAN_GABON_PRESET: MatchConfig = {
  matchInfo: {
    title: "Ouzbékistan vs Gabon",
    competition: "FIFA Series",
    fixture_id: "fifa-series-uzbekistan-gabon",
    home: "Ouzbékistan",
    away: "Gabon",
    home_initials: "UZB",
    away_initials: "GAB",
    matchLength: 90,
    halftime: 45,
  },
  roster: {
    homeStarting: [
      { numero: 1, nom: "U. Yusupov" },
      { numero: 5, nom: "R. Ashurmatov" },
      { numero: 15, nom: "U. Eshmurodov" },
      { numero: 3, nom: "K. Alizhonov" },
      { numero: 13, nom: "S. Nasrullayev" },
      { numero: 7, nom: "O. Shukurov" },
      { numero: 9, nom: "O. Khamrobekov" },
      { numero: 18, nom: "A. Abdullayev" },
      { numero: 23, nom: "K. Alikulov" },
      { numero: 14, nom: "E. Shomurodov" },
      { numero: 11, nom: "J. Urozov" },
    ],
    awayStarting: [
      { numero: 16, nom: "F. Bekale" },
      { numero: 6, nom: "J. Obiang" },
      { numero: 21, nom: "Jérémy Oyono" },
      { numero: 13, nom: "Mick Omfia" },
      { numero: 4, nom: "U. Mboula" },
      { numero: 12, nom: "Guelor Kanga" },
      { numero: 22, nom: "Didier Ndong" },
      { numero: 9, nom: "Teddy Averlant" },
      { numero: 15, nom: "S. Nzé" },
      { numero: 11, nom: "D. Sambissa" },
      { numero: 7, nom: "Jim Allevinah" },
    ],
    homeBench: [
      { numero: 16, nom: "B. Ergashev (GK)" },
      { numero: 12, nom: "A. Nematov (GK)" },
      { numero: 20, nom: "B. Karimov" },
      { numero: 25, nom: "M. Khamraliyev" },
      { numero: 23, nom: "M. Abdumajidov" },
      { numero: 4, nom: "F. Sayfiyev" },
      { numero: 19, nom: "I. Ibrokhimov" },
      { numero: 8, nom: "J. Iskanderov" },
      { numero: 6, nom: "A. Mozgovoy" },
      { numero: 22, nom: "U. Rahmonaleiv" },
      { numero: 17, nom: "D. Khamdamov" },
      { numero: 18, nom: "Alisher Odilov" },
      { numero: 21, nom: "I. Sergeev" },
      { numero: 26, nom: "S. Temirov" },
    ],
    awayBench: [
      { numero: 23, nom: "L. Mbaba (GK)" },
      { numero: 3, nom: "O. Bagnama" },
      { numero: 17, nom: "Y. M'Bemba" },
      { numero: 18, nom: "F. Owanga" },
      { numero: 8, nom: "Noha Lemina" },
      { numero: 11, nom: "B. Meshak" },
      { numero: 14, nom: "Eric Bocoum" },
      { numero: 19, nom: "Ben Kabinambele" },
      { numero: 20, nom: "Edlin Matouti" },
    ],
  },
};

export function getUzbekistanGabonPreset(): MatchConfig {
  return JSON.parse(JSON.stringify(UZBEKISTAN_GABON_PRESET)) as MatchConfig;
}
