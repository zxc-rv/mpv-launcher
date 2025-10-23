import {
  Grid,
  ActionPanel,
  Action,
  showToast,
  Toast,
  getPreferenceValues,
  LocalStorage,
  closeMainWindow,
  Icon,
  confirmAlert,
  Alert,
  environment,
  Keyboard,
} from "@raycast/api";
import { useEffect, useState, useMemo, useCallback } from "react";
import { readdir, rm, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { createHash } from "crypto";

interface Settings {
  animeDirectory: string;
  filmsDirectory: string;
  seriesDirectory: string;
  animeArguments: string;
  filmsArguments: string;
  seriesArguments: string;
}

interface TitleFolder {
  name: string;
  path: string;
  type: "anime" | "series" | "film";
  seriesCount: number;
}

const pluralRules = new Intl.PluralRules("ru");
const LAST_PLAYED_KEY = "last_played_media_v4";
const THUMBNAILS_CACHE_KEY = "thumbnails_cache_v1";
const processingThumbnails = new Set<string>();
const thumbnailCachePath = join(environment.supportPath, "thumbnails");
let activeGenerations = 0;

export default function Command() {
  const {
    animeDirectory,
    filmsDirectory,
    seriesDirectory,
    animeArguments,
    filmsArguments,
    seriesArguments,
  } = getPreferenceValues<Settings>();

  const [folders, setFolders] = useState<TitleFolder[]>([]);
  const [lastPlayed, setLastPlayed] = useState<TitleFolder[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const filteredFolders = useMemo(() => {
    let filtered = folders;

    if (searchText) {
      const searchLower = searchText.toLowerCase();
      filtered = folders.filter((folder) =>
        folder.name.toLowerCase().includes(searchLower),
      );
    }

    return filtered.reduce(
      (acc, folder) => {
        if (!acc[folder.type]) acc[folder.type] = [];
        acc[folder.type].push(folder);
        return acc;
      },
      {} as Record<string, TitleFolder[]>,
    );
  }, [folders, searchText]);

  const titlePaths = new Set(folders.map((f) => f.path));
  const sortedLastPlayed = lastPlayed.filter((item) =>
    titlePaths.has(item.path),
  );

  useEffect(() => {
    (async () => {
      await mkdir(thumbnailCachePath, { recursive: true });

      const [lastPlayedJson, thumbnailsJson] = await Promise.all([
        LocalStorage.getItem<string>(LAST_PLAYED_KEY),
        LocalStorage.getItem<string>(THUMBNAILS_CACHE_KEY),
      ]);

      if (lastPlayedJson) setLastPlayed(JSON.parse(lastPlayedJson));
      if (thumbnailsJson) {
        const cache = JSON.parse(thumbnailsJson);
        const validThumbnails: Record<string, string> = {};

        Object.entries(cache.thumbnails).forEach(([path, thumbPath]) => {
          if (existsSync(thumbPath as string)) {
            validThumbnails[path] = thumbPath as string;
          }
        });

        setThumbnails(validThumbnails);
      }

      const freshFolders = await loadFreshFolders();
      setFolders(freshFolders);
      setIsLoading(false);
    })();
  }, []);

  async function saveThumbnailsCache(thumbnailsData: Record<string, string>) {
    await LocalStorage.setItem(
      THUMBNAILS_CACHE_KEY,
      JSON.stringify({ thumbnails: thumbnailsData, lastUpdated: Date.now() }),
    );
  }

  async function saveLastPlayed(folder: TitleFolder) {
    const updatedLastPlayed = [
      folder,
      ...lastPlayed.filter((item) => item.path !== folder.path),
    ].slice(0, 5);

    await LocalStorage.setItem(
      LAST_PLAYED_KEY,
      JSON.stringify(updatedLastPlayed),
    );
    setLastPlayed(updatedLastPlayed);
  }

  async function loadFoldersFromDirectory(
    directory: string,
    type: "anime" | "film" | "series",
  ): Promise<TitleFolder[]> {
    try {
      const items = await readdir(directory, { withFileTypes: true });
      const directories = items.filter((item) => item.isDirectory());

      const folders = await Promise.all(
        directories.map(async (dir) => {
          const titlePath = join(directory, dir.name);
          const titleInfo = await getTitleInfo(titlePath);

          return {
            name: dir.name,
            path: titlePath,
            type,
            seriesCount: titleInfo.count,
          };
        }),
      );

      return folders;
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: `Error loading ${type} folders`,
        message: `Make sure the directory "${directory}" exists`,
      });
      return [];
    }
  }

  async function loadFreshFolders(): Promise<TitleFolder[]> {
    const [animeFolders, filmFolders, seriesFolders] = await Promise.all([
      loadFoldersFromDirectory(animeDirectory, "anime"),
      loadFoldersFromDirectory(seriesDirectory, "series"),
      loadFoldersFromDirectory(filmsDirectory, "film"),
    ]);

    return [...animeFolders, ...filmFolders, ...seriesFolders].sort((a, b) =>
      a.name.localeCompare(b.name, "ru", { numeric: true }),
    );
  }

  const checkThumbnail = useCallback(
    async (path: string) => {
      if (thumbnails[path] || processingThumbnails.has(path)) return;

      if (activeGenerations >= 3) {
        console.log("[THUMBNAIL] Queue full, skipping:", path);
        return;
      }

      processingThumbnails.add(path);
      activeGenerations++;

      const titleInfo = await getTitleInfo(path);
      if (!titleInfo.file) {
        processingThumbnails.delete(path);
        activeGenerations--;
        return;
      }

      const hash = createHash("md5").update(titleInfo.file).digest("hex");
      const thumbnailPath = join(thumbnailCachePath, `${hash}.jpg`);

      if (existsSync(thumbnailPath)) {
        setThumbnails((prev) => {
          const updated = { ...prev, [path]: thumbnailPath };
          saveThumbnailsCache(updated);
          return updated;
        });
        processingThumbnails.delete(path);
        activeGenerations--;
        return;
      }

      try {
        await generateThumbnail(titleInfo.file, thumbnailPath);
        setThumbnails((prev) => {
          const updated = { ...prev, [path]: thumbnailPath };
          saveThumbnailsCache(updated);
          return updated;
        });
      } catch (error) {
        console.error(`Thumbnail generation failed for ${path}:`, error);
      } finally {
        processingThumbnails.delete(path);
        activeGenerations--;
      }
    },
    [thumbnails],
  );

  async function play(folder: TitleFolder) {
    try {
      const titleInfo = await getTitleInfo(folder.path);
      if (!titleInfo.file) throw new Error("No video found");
      const argsMap = {
        anime: animeArguments,
        series: seriesArguments,
        film: filmsArguments,
      };
      const argsString = argsMap[folder.type] || "";
      const args = argsString.split(" ").filter(Boolean);

      console.log(`[PLAY] Launching mpv with: ${titleInfo.file}`);
      spawn("mpv", [titleInfo.file, ...args], { stdio: "ignore" }).unref();
      closeMainWindow();
      saveLastPlayed(folder);
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  function formatSeriesCount(count: number): string {
    const forms: Record<string, string> = {
      one: "серия",
      few: "серии",
      many: "серий",
      other: "серий",
    };
    return `${count} ${forms[pluralRules.select(count)]}`;
  }

  async function deleteTitleFolder(folder: TitleFolder) {
    if (
      await confirmAlert({
        title: `Delete "${folder.name}"?`,
        message: "This action is permanent and cannot be undone.",
        icon: Icon.Trash,
        primaryAction: {
          title: "Delete",
          style: Alert.ActionStyle.Destructive,
        },
      })
    ) {
      try {
        await rm(folder.path, { recursive: true, force: true });
        showToast({
          style: Toast.Style.Success,
          title: "Folder Deleted",
          message: `Removed "${folder.name}"`,
        });

        const updatedFolders = folders.filter((f) => f.path !== folder.path);
        const updatedLastPlayed = lastPlayed.filter(
          (item) => item.path !== folder.path,
        );

        setFolders(updatedFolders);
        setLastPlayed(updatedLastPlayed);

        await LocalStorage.setItem(
          LAST_PLAYED_KEY,
          JSON.stringify(updatedLastPlayed),
        );

        setThumbnails((prev) => {
          const updated = { ...prev };
          delete updated[folder.path];
          saveThumbnailsCache(updated);
          return updated;
        });

        const thumbnailPath = thumbnails[folder.path];
        if (thumbnailPath && existsSync(thumbnailPath)) {
          await rm(thumbnailPath).catch(console.error);
        }
      } catch (error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Deletion Failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  const titleActions = useCallback(
    (folder: TitleFolder, isLastPlayed = false) => (
      <ActionPanel>
        <ActionPanel.Section>
          <Action
            title={isLastPlayed ? "Продолжить просмотр" : "Начать просмотр"}
            onAction={() => play(folder)}
            icon={Icon.Play}
          />
          <Action.Open
            title="Открыть директорию"
            target={folder.path}
            icon={Icon.Folder}
          />
        </ActionPanel.Section>
        <ActionPanel.Section>
          <Action
            title="Удалить директорию"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={() => deleteTitleFolder(folder)}
            shortcut={Keyboard.Shortcut.Common.Remove}
          />
        </ActionPanel.Section>
      </ActionPanel>
    ),
    [folders, lastPlayed],
  );

  const typeDisplayNames = {
    anime: "Аниме",
    series: "Сериалы",
    film: "Фильмы",
  };

  const getIconForType = (type: TitleFolder["type"]) => {
    if (type === "anime") return "🎌";
    if (type === "series") return "📺";
    if (type === "film") return "🎬";
    return Icon.QuestionMark;
  };

  const GridItemWithLazyThumbnail = useCallback(
    ({
      folder,
      isLastPlayed = false,
    }: {
      folder: TitleFolder;
      isLastPlayed?: boolean;
    }) => {
      useEffect(() => {
        if (!thumbnails[folder.path]) checkThumbnail(folder.path);
      }, [folder.path]);

      const subtitle =
        folder.type !== "film"
          ? formatSeriesCount(folder.seriesCount)
          : undefined;
      const content = thumbnails[folder.path]
        ? `file://${thumbnails[folder.path]}`
        : getIconForType(folder.type);

      return (
        <Grid.Item
          key={folder.path}
          title={folder.name}
          subtitle={subtitle}
          content={content}
          actions={titleActions(folder, isLastPlayed)}
        />
      );
    },
    [thumbnails, checkThumbnail, titleActions],
  );

  return (
    <Grid
      fit={Grid.Fit.Fill}
      aspectRatio="4/3"
      isLoading={isLoading}
      searchBarPlaceholder="Поиск..."
      columns={5}
      onSearchTextChange={setSearchText}
      searchText={searchText}
      navigationTitle="MPV Launcher"
    >
      {sortedLastPlayed.length > 0 && !searchText && (
        <Grid.Section title="Продолжить просмотр">
          {sortedLastPlayed.map((item) => {
            const actualFolder = folders.find((f) => f.path === item.path);
            if (!actualFolder) return null;

            return (
              <GridItemWithLazyThumbnail
                key={item.path}
                folder={actualFolder}
                isLastPlayed={true}
              />
            );
          })}
        </Grid.Section>
      )}
      {(["anime", "series", "film"] as const).map((type) => {
        const typeFolders = filteredFolders[type] || [];
        if (typeFolders.length === 0) return null;
        return (
          <Grid.Section key={type} title={typeDisplayNames[type]}>
            {typeFolders.map((folder) => (
              <GridItemWithLazyThumbnail key={folder.path} folder={folder} />
            ))}
          </Grid.Section>
        );
      })}
    </Grid>
  );
}

async function getTitleInfo(path: string) {
  try {
    const files = await readdir(path);
    const re = /\.(mp4|mkv|avi|webm|mov|m4v|flv)$/i;
    let first: string | null = null;
    let count = 0;

    for (const f of files) {
      if (!re.test(f)) continue;
      count++;
      if (!first) first = f;
      else if (f.localeCompare(first, undefined, { numeric: true }) < 0) {
        first = f;
      }
    }

    return {
      file: first ? join(path, first) : null,
      count,
    };
  } catch {
    return { file: null, count: 0 };
  }
}

async function generateThumbnail(videoFile: string, thumbnailPath: string) {
  const args = [
    "-ss",
    "00:05:00",
    "-i",
    videoFile,
    "-vframes",
    "1",
    "-f",
    "image2",
    "-y",
    "-loglevel",
    "quiet",
    "-preset",
    "ultrafast",
    "-vf",
    "scale=480:270",
    thumbnailPath,
  ];

  const ffmpeg = spawn("ffmpeg", args);

  await new Promise<void>((resolve, reject) => {
    ffmpeg.on("close", (code) => {
      if (code === 0 && existsSync(thumbnailPath)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });

    ffmpeg.on("error", reject);

    setTimeout(() => {
      ffmpeg.kill();
      reject(new Error("FFmpeg timeout"));
    }, 10000);
  });
}
