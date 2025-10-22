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

interface Preferences {
  animeDirectory: string;
  filmsDirectory: string;
  seriesDirectory: string;
  animeArguments: string;
  filmsArguments: string;
  seriesArguments: string;
}

interface MediaFolder {
  name: string;
  path: string;
  type: "anime" | "series" | "film";
  seriesCount: number;
}

interface LastPlayedMedia extends MediaFolder {
  id: string;
  lastPlayedAt: number;
}

const LAST_PLAYED_KEY = "last_played_media_v3";
const THUMBNAILS_CACHE_KEY = "thumbnails_cache_v1";
const thumbnailCachePath = join(environment.supportPath, "thumbnails");
const processingThumbnails = new Set<string>();
const videoCache = new Map<string, { file: string | null; count: number }>();
let activeGenerations = 0;

export default function Command() {
  const {
    animeDirectory,
    filmsDirectory,
    seriesDirectory,
    animeArguments,
    filmsArguments,
    seriesArguments,
  } = getPreferenceValues<Preferences>();

  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [lastPlayed, setLastPlayed] = useState<LastPlayedMedia[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const debouncedSearch = useDebounce(searchText, 50);

  const filteredFolders = useMemo(() => {
    let filtered = folders;

    if (debouncedSearch) {
      const searchLower = debouncedSearch.toLowerCase();
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
      {} as Record<string, MediaFolder[]>,
    );
  }, [folders, debouncedSearch]);

  const sortedLastPlayed = useMemo(() => {
    return lastPlayed
      .filter((item) => folders.some((f) => f.path === item.path))
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 5);
  }, [lastPlayed, folders]);

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

  async function saveLastPlayed(folder: MediaFolder) {
    const newItem: LastPlayedMedia = {
      ...folder,
      id: `${folder.path}-${Date.now()}`,
      lastPlayedAt: Date.now(),
    };

    const updatedLastPlayed = [
      newItem,
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
  ): Promise<MediaFolder[]> {
    try {
      const items = await readdir(directory, { withFileTypes: true });
      const directories = items.filter((item) => item.isDirectory());

      const folders = await Promise.all(
        directories.map(async (dir) => {
          const folderPath = join(directory, dir.name);
          const folderInfo = await getFolderInfo(folderPath);

          return {
            name: dir.name,
            path: folderPath,
            type,
            seriesCount: folderInfo.count,
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

  async function loadFreshFolders(): Promise<MediaFolder[]> {
    const [animeFolders, filmFolders, seriesFolders] = await Promise.all([
      loadFoldersFromDirectory(animeDirectory, "anime"),
      loadFoldersFromDirectory(seriesDirectory, "series"),
      loadFoldersFromDirectory(filmsDirectory, "film"),
    ]);

    return [...animeFolders, ...filmFolders, ...seriesFolders].sort((a, b) =>
      a.name.localeCompare(b.name, "ru", { numeric: true }),
    );
  }

  const handleItemVisible = useCallback(
    async (path: string) => {
      if (thumbnails[path] || processingThumbnails.has(path)) return;

      if (activeGenerations >= 3) {
        console.log("[THUMBNAIL] Queue full, skipping:", path);
        return;
      }

      processingThumbnails.add(path);
      activeGenerations++;

      const folderInfo = await getFolderInfo(path);
      if (!folderInfo.file) {
        processingThumbnails.delete(path);
        activeGenerations--;
        return;
      }

      const hash = createHash("md5").update(folderInfo.file).digest("hex");
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
        await generateThumbnail(folderInfo.file, thumbnailPath);
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

  async function play(folder: MediaFolder) {
    try {
      const folderInfo = await getFolderInfo(folder.path);
      if (!folderInfo.file) throw new Error("No video files found in folder");

      const argsMap = {
        anime: animeArguments,
        film: filmsArguments,
        series: seriesArguments,
      };

      const argsString = argsMap[folder.type] || "";
      const args = argsString.split(" ").filter(Boolean);

      console.log(`[PLAY] Launching mpv with: ${folderInfo.file}`);
      spawn("mpv", [folderInfo.file, ...args], { stdio: "ignore" }).unref();

      await saveLastPlayed(folder);
      await closeMainWindow();
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error preparing to play video",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  function formatSeriesCount(count: number): string {
    const forms = ["серия", "серии", "серий"];
    const n = Math.abs(count) % 100;
    const n1 = n % 10;
    let form = forms[2];
    if (n > 10 && n < 20) form = forms[2];
    else if (n1 > 1 && n1 < 5) form = forms[1];
    else if (n1 === 1) form = forms[0];
    return `${count} ${form}`;
  }

  async function deleteMediaFolder(folder: MediaFolder) {
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

  const mediaActions = useCallback(
    (folder: MediaFolder, isLastPlayed = false) => (
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
            onAction={() => deleteMediaFolder(folder)}
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

  const getIconForType = (type: MediaFolder["type"]) => {
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
      folder: MediaFolder | LastPlayedMedia;
      isLastPlayed?: boolean;
    }) => {
      useEffect(() => {
        if (!thumbnails[folder.path]) handleItemVisible(folder.path);
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
          key={isLastPlayed ? (folder as LastPlayedMedia).id : folder.path}
          title={folder.name}
          subtitle={subtitle}
          content={content}
          actions={mediaActions(folder, isLastPlayed)}
        />
      );
    },
    [thumbnails, handleItemVisible, mediaActions],
  );

  return (
    <Grid
      fit={Grid.Fit.Fill}
      aspectRatio="4/3"
      isLoading={isLoading}
      searchBarPlaceholder="Поиск тайтлов..."
      columns={5}
      onSearchTextChange={setSearchText}
      searchText={searchText}
      navigationTitle="MPV Launcher"
    >
      {sortedLastPlayed.length > 0 && !debouncedSearch && (
        <Grid.Section title="Продолжить просмотр">
          {sortedLastPlayed.map((item) => {
            const actualFolder = folders.find((f) => f.path === item.path);
            if (!actualFolder) return null;

            const folderWithLastPlayedData = {
              ...actualFolder,
              id: item.id,
              lastPlayedAt: item.lastPlayedAt,
            };
            return (
              <GridItemWithLazyThumbnail
                key={item.id}
                folder={folderWithLastPlayedData}
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

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

async function getFolderInfo(
  path: string,
): Promise<{ file: string | null; count: number }> {
  if (videoCache.has(path)) return videoCache.get(path)!;

  try {
    const files = await readdir(path);
    const videoFiles = files
      .filter((f) => /\.(mp4|mkv|avi|webm|mov|m4v|flv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const file = videoFiles[0] ? join(path, videoFiles[0]) : null;
    const count = videoFiles.length;
    const result = { file, count };

    videoCache.set(path, result);
    return result;
  } catch (error) {
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
