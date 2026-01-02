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
} from "@raycast/api";
import { useEffect, useState, useMemo, useCallback } from "react";
import { readdir, rm, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { writeFile } from "fs/promises";

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

interface ThumbnailsCacheEntry {
  thumbnailPath: string;
  fileHash: string;
}

const pluralRules = new Intl.PluralRules("ru");
const LAST_PLAYED_KEY = "last_played_media_v4";
const THUMBNAILS_CACHE_KEY = "thumbnails_cache_v1";
const processingThumbnails = new Set<string>();
const thumbnailCachePath = join(environment.supportPath, "thumbnails");
const ffmpegPath = join(environment.supportPath, "bin", "ffmpeg.exe");
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

  const [titles, setTitles] = useState<TitleFolder[]>([]);
  const [lastPlayed, setLastPlayed] = useState<TitleFolder[]>([]);
  const [thumbnails, setThumbnails] = useState<
    Record<string, ThumbnailsCacheEntry>
  >({});
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const filteredtitles = useMemo(() => {
    let filtered = titles;

    if (searchText) {
      const searchLower = searchText.toLowerCase();
      filtered = titles.filter((title) =>
        title.name.toLowerCase().includes(searchLower),
      );
    }

    return filtered.reduce(
      (acc, title) => {
        if (!acc[title.type]) acc[title.type] = [];
        acc[title.type].push(title);
        return acc;
      },
      {} as Record<string, TitleFolder[]>,
    );
  }, [titles, searchText]);

  const titlePaths = new Set(titles.map((f) => f.path));
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
        const validThumbnails: Record<string, ThumbnailsCacheEntry> = {};

        for (const [path, entry] of Object.entries(cache.thumbnails)) {
          if (typeof entry === "string") {
            if (existsSync(entry)) {
              validThumbnails[path] = { thumbnailPath: entry, fileHash: "" };
            }
          } else {
            const e = entry as ThumbnailsCacheEntry;
            if (existsSync(e.thumbnailPath)) {
              validThumbnails[path] = e;
            }
          }
        }

        setThumbnails(validThumbnails);
      }

      const titles = await loadTitles();
      setTitles(titles);
      setIsLoading(false);
    })();
  }, []);

  async function saveThumbnailsCache(
    thumbnailsData: Record<string, ThumbnailsCacheEntry>,
  ) {
    await LocalStorage.setItem(
      THUMBNAILS_CACHE_KEY,
      JSON.stringify({ thumbnails: thumbnailsData, lastUpdated: Date.now() }),
    );
  }

  async function saveLastPlayed(title: TitleFolder) {
    const updatedLastPlayed = [
      title,
      ...lastPlayed.filter((item) => item.path !== title.path),
    ].slice(0, 5);

    await LocalStorage.setItem(
      LAST_PLAYED_KEY,
      JSON.stringify(updatedLastPlayed),
    );
    setLastPlayed(updatedLastPlayed);
  }

  async function loadTitles(): Promise<TitleFolder[]> {
    const directories = [
      { path: animeDirectory, type: "anime" as const },
      { path: seriesDirectory, type: "series" as const },
      { path: filmsDirectory, type: "film" as const },
    ];
    const results = await Promise.all(
      directories.map(async ({ path, type }) => {
        try {
          const items = await readdir(path, { withFileTypes: true });
          const dirs = items.filter((item) => item.isDirectory());
          return await Promise.all(
            dirs.map(async (dir) => {
              const titlePath = join(path, dir.name);
              const titleInfo = await getTitleInfo(titlePath);
              return {
                name: dir.name,
                path: titlePath,
                type,
                seriesCount: titleInfo.count,
              };
            }),
          );
        } catch {
          showToast({
            style: Toast.Style.Failure,
            title: `Error loading ${type} titles`,
            message: `Make sure the directory "${path}" exists`,
          });
          return [];
        }
      }),
    );
    return results
      .flat()
      .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
  }

  const checkThumbnail = useCallback(
    async (path: string) => {
      const titleInfo = await getTitleInfo(path);
      if (!titleInfo.file) {
        if (thumbnails[path]) {
          setThumbnails((prev) => {
            const updated = { ...prev };
            delete updated[path];
            saveThumbnailsCache(updated);
            return updated;
          });
        }
        return;
      }
      const fileHash = createHash("md5").update(titleInfo.file).digest("hex");
      const cached = thumbnails[path];
      if (
        cached &&
        cached.fileHash === fileHash &&
        existsSync(cached.thumbnailPath)
      ) {
        return;
      }
      if (processingThumbnails.has(path) || activeGenerations >= 3) return;

      if (cached?.thumbnailPath && existsSync(cached.thumbnailPath)) {
        await rm(cached.thumbnailPath).catch(console.error);
      }
      processingThumbnails.add(path);
      activeGenerations++;

      const hash = createHash("md5").update(titleInfo.file).digest("hex");
      const thumbnailPath = join(thumbnailCachePath, `${hash}.jpg`);
      if (existsSync(thumbnailPath)) {
        setThumbnails((prev) => {
          if (
            prev[path]?.thumbnailPath === thumbnailPath &&
            prev[path]?.fileHash === fileHash
          ) {
            return prev;
          }
          const updated = { ...prev, [path]: { thumbnailPath, fileHash } };
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
          if (
            prev[path]?.thumbnailPath === thumbnailPath &&
            prev[path]?.fileHash === fileHash
          ) {
            return prev;
          }
          const updated = { ...prev, [path]: { thumbnailPath, fileHash } };
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

  async function play(title: TitleFolder) {
    try {
      const titleInfo = await getTitleInfo(title.path);
      if (!titleInfo.file) throw new Error("No video found");
      const argsMap = {
        anime: animeArguments,
        series: seriesArguments,
        film: filmsArguments,
      };
      const argsString = argsMap[title.type] || "";
      const args = argsString.split(" ").filter(Boolean);

      //console.log(`[PLAY] Launching mpv with: ${titleInfo.file}`);
      spawn("mpv", [titleInfo.file, ...args], { stdio: "ignore" }).unref();
      closeMainWindow();
      saveLastPlayed(title);
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

  async function deleteTitleFolder(title: TitleFolder) {
    if (
      await confirmAlert({
        title: `Delete "${title.name}"?`,
        message: "This action is permanent and cannot be undone.",
        icon: Icon.Trash,
        primaryAction: {
          title: "Delete",
          style: Alert.ActionStyle.Destructive,
        },
      })
    ) {
      try {
        await rm(title.path, { recursive: true, force: true });
        showToast({
          style: Toast.Style.Success,
          title: "Folder Deleted",
          message: `Removed "${title.name}"`,
        });

        const updatedTitles = titles.filter((f) => f.path !== title.path);
        const updatedLastPlayed = lastPlayed.filter(
          (item) => item.path !== title.path,
        );

        setTitles(updatedTitles);
        setLastPlayed(updatedLastPlayed);

        await LocalStorage.setItem(
          LAST_PLAYED_KEY,
          JSON.stringify(updatedLastPlayed),
        );

        const cached = thumbnails[title.path];
        if (cached?.thumbnailPath && existsSync(cached.thumbnailPath)) {
          await rm(cached.thumbnailPath).catch(console.error);
        }

        setThumbnails((prev) => {
          const updated = { ...prev };
          delete updated[title.path];
          saveThumbnailsCache(updated);
          return updated;
        });
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
    (title: TitleFolder, isLastPlayed = false) => (
      <ActionPanel>
        <ActionPanel.Section>
          <Action
            title={isLastPlayed ? "Продолжить просмотр" : "Начать просмотр"}
            onAction={() => play(title)}
            icon={Icon.Play}
          />
          <Action.Open
            title="Открыть директорию"
            target={title.path}
            icon={Icon.Folder}
            shortcut={{ modifiers: ["ctrl"], key: "enter" }}
          />
        </ActionPanel.Section>
        <ActionPanel.Section>
          <Action
            title="Удалить директорию"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={() => deleteTitleFolder(title)}
            shortcut={{ modifiers: ["ctrl"], key: "d" }}
          />
        </ActionPanel.Section>
      </ActionPanel>
    ),
    [titles, lastPlayed],
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
      title,
      isLastPlayed = false,
    }: {
      title: TitleFolder;
      isLastPlayed?: boolean;
    }) => {
      useEffect(() => {
        checkThumbnail(title.path);
      }, [title.path]);

      const subtitle =
        title.type !== "film"
          ? formatSeriesCount(title.seriesCount)
          : undefined;
      const content = thumbnails[title.path]?.thumbnailPath
        ? `file://${thumbnails[title.path].thumbnailPath}`
        : getIconForType(title.type);

      return (
        <Grid.Item
          key={title.path}
          title={title.name}
          subtitle={subtitle}
          content={content}
          actions={titleActions(title, isLastPlayed)}
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
            const actualTitle = titles.find((f) => f.path === item.path);
            if (!actualTitle) return null;

            return (
              <GridItemWithLazyThumbnail
                key={item.path}
                title={actualTitle}
                isLastPlayed={true}
              />
            );
          })}
        </Grid.Section>
      )}
      {(["anime", "series", "film"] as const).map((type) => {
        const typetitles = filteredtitles[type] || [];
        if (typetitles.length === 0) return null;
        return (
          <Grid.Section key={type} title={typeDisplayNames[type]}>
            {typetitles.map((title) => (
              <GridItemWithLazyThumbnail key={title.path} title={title} />
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

async function getFFmpeg(): Promise<string> {
  try {
    await new Promise((resolve, reject) => {
      spawn("ffmpeg", ["-version"], { stdio: "ignore" })
        .on("close", (code) => (code === 0 ? resolve(null) : reject()))
        .on("error", reject);
    });
    return "ffmpeg";
  } catch {
    if (existsSync(ffmpegPath)) return ffmpegPath;
    await mkdir(join(environment.supportPath, "bin"), { recursive: true });
    await showToast({
      style: Toast.Style.Animated,
      title: "Загрузка ffmpeg...",
    });

    const url =
      "https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-win32-x64";
    const response = await fetch(url);
    if (!response.ok) throw new Error("Не удалось скачать");
    const buffer = await response.arrayBuffer();
    await writeFile(ffmpegPath, new Uint8Array(buffer));
    await showToast({
      style: Toast.Style.Success,
      title: "ffmpeg загружен",
    });

    return ffmpegPath;
  }
}

async function generateThumbnail(videoFile: string, thumbnailPath: string) {
  const ffmpegBin = await getFFmpeg();
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

  const ffmpeg = spawn(ffmpegBin, args);

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
