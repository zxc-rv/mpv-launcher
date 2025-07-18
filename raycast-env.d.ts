/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Путь к аниме - Full path to your anime directory */
  "animeDirectory": string,
  /** Аргументы для аниме - Command line arguments for anime */
  "animeArguments": string,
  /** Путь к сериалам - The directory where your series are stored. */
  "seriesDirectory": string,
  /** Аргументы для сериалов - Command line arguments for series */
  "seriesArguments": string,
  /** Путь к фильмам - Full path to your films directory */
  "filmsDirectory": string,
  /** Аргументы для фильмов - Command line arguments for films */
  "filmsArguments": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `mpv-launcher` command */
  export type MpvLauncher = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `mpv-launcher` command */
  export type MpvLauncher = {}
}

