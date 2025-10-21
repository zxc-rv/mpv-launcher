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
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { readdir, rm, stat, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { createHash } from "crypto";

const LAST_PLAYED_KEY = "last_played_media_v3";
const THUMBNAILS_CACHE_KEY = "thumbnails_cache_v1";

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
  thumbnail?: string;
  lastModified?: number;
}

interface LastPlayedMedia extends MediaFolder {
  id: string;
  lastPlayedAt: number;
}

interface ThumbnailsCache {
  thumbnails: Record<string, string>;
  lastUpdated: number;
}

const thumbnailCachePath = join(environment.supportPath, "thumbnails");

// Хук для дебаунсинга
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Класс для управления очередью генерации миниатюр
class ThumbnailQueue {
  private queue: Array<{ path: string; callback: (path: string) => void }> = [];
  private processing = 0;
  private maxConcurrent = 2;
  private processingPaths = new Set<string>();

  add(path: string, callback: (path: string) => void) {
    if (this.processingPaths.has(path)) return;
    this.queue.push({ path, callback });
    this.processNext();
  }

  private async processNext() {
    if (this.processing >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.processing++;
    this.processingPaths.add(item.path);

    try {
      await this.generateThumbnail(item.path, item.callback);
    } finally {
      this.processing--;
      this.processingPaths.delete(item.path);
      setTimeout(() => this.processNext(), 100);
    }
  }

  private async generateThumbnail(
    folderPath: string,
    onThumbnailGenerated: (path: string) => void,
  ) {
    try {
      const videoFile = await findFirstVideoFile(folderPath);
      if (!videoFile) return;

      const hash = createHash("md5").update(videoFile).digest("hex");
      const thumbnailFile = `${hash}.jpg`;
      const thumbnailPath = join(thumbnailCachePath, thumbnailFile);

      if (existsSync(thumbnailPath)) {
        onThumbnailGenerated(thumbnailPath);
        return;
      }

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
            onThumbnailGenerated(thumbnailPath);
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });

        ffmpeg.on("error", (err) => {
          reject(err);
        });

        setTimeout(() => {
          ffmpeg.kill();
          reject(new Error("FFmpeg timeout"));
        }, 10000);
      });
    } catch (error) {
      console.error(`Thumbnail generation failed for ${folderPath}:`, error);
    }
  }
}

const thumbnailQueue = new ThumbnailQueue();

async function findFirstVideoFile(folderPath: string): Promise<string | null> {
  try {
    const files = await readdir(folderPath);
    const videoFiles = files
      .filter((file) => /\.(mp4|mkv|avi|webm|mov|m4v|flv)$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return videoFiles.length > 0 ? join(folderPath, videoFiles[0]) : null;
  } catch (error) {
    console.error("Error finding video file:", error);
    return null;
  }
}

// Оптимизированный подсчет видеофайлов с кешированием
const videoCountCache = new Map<
  string,
  { count: number; lastModified: number }
>();

async function countVideoFiles(folderPath: string): Promise<number> {
  try {
    const folderStat = await stat(folderPath);
    const lastModified = folderStat.mtime.getTime();

    const cached = videoCountCache.get(folderPath);
    if (cached && cached.lastModified === lastModified) {
      return cached.count;
    }

    const files = await readdir(folderPath);
    const count = files.filter((file) =>
      /\.(mp4|mkv|avi|webm|mov|m4v|flv)$/i.test(file),
    ).length;

    videoCountCache.set(folderPath, { count, lastModified });
    return count;
  } catch {
    return 0;
  }
}

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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasInitialData, setHasInitialData] = useState(false);

  const debouncedSearch = useDebounce(searchText, 50);
  const visibleItemsRef = useRef<Set<string>>(new Set());
  const initializationRef = useRef<boolean>(false);

  // Мемоизация фильтрации
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
      .filter((item) => folders.some((f) => f.path === item.path)) // Показываем только те, что есть в folders
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 5);
  }, [lastPlayed, folders]);

  useEffect(() => {
    async function initialLoad() {
      if (initializationRef.current) return;
      initializationRef.current = true;

      await mkdir(thumbnailCachePath, { recursive: true });

      try {
        const [lastPlayedJson, thumbnailsJson] = await Promise.all([
          LocalStorage.getItem<string>(LAST_PLAYED_KEY),
          LocalStorage.getItem<string>(THUMBNAILS_CACHE_KEY),
        ]);

        // Устанавливаем кешированные данные
        if (lastPlayedJson) {
          const lastPlayedData = JSON.parse(
            lastPlayedJson,
          ) as LastPlayedMedia[];
          setLastPlayed(lastPlayedData);
        }

        if (thumbnailsJson) {
          const cache: ThumbnailsCache = JSON.parse(thumbnailsJson);
          setThumbnails(cache.thumbnails);
        }

        // Всегда загружаем свежие папки
        await refreshFoldersSilent();

        // Фоновые задачи
        setTimeout(async () => {
          if (lastPlayedJson) verifyLastPlayedInBackground();
          await preloadExistingThumbnails();
        }, 200);
      } catch (error) {
        console.error("Error in initial load:", error);
        setIsLoading(false);
        setTimeout(() => refreshFoldersSilent(), 100);
      }
    }
    initialLoad();

    return () => {
      initializationRef.current = false;
    };
  }, []);

  // Предзагрузка миниатюр для последних просмотренных
  useEffect(() => {
    if (sortedLastPlayed.length === 0) return;

    // Приоритетная загрузка миниатюр для последних просмотренных
    sortedLastPlayed.slice(0, 3).forEach((item, index) => {
      if (!thumbnails[item.path]) {
        setTimeout(() => handleItemVisible(item.path), index * 30);
      }
    });
  }, [sortedLastPlayed]);

  async function verifyLastPlayedInBackground() {
    try {
      const existenceChecks = await Promise.allSettled(
        lastPlayed.map((item) => stat(item.path)),
      );

      const existingLastPlayed = lastPlayed.filter(
        (_, index) => existenceChecks[index].status === "fulfilled",
      );

      if (existingLastPlayed.length !== lastPlayed.length) {
        await LocalStorage.setItem(
          LAST_PLAYED_KEY,
          JSON.stringify(existingLastPlayed),
        );
        setLastPlayed(existingLastPlayed);
      }
    } catch (error) {
      console.error("Error verifying last played:", error);
    }
  }

  async function syncLastPlayedWithFolders() {
    if (lastPlayed.length === 0 || folders.length === 0) return;

    let hasUpdates = false;
    const updatedLastPlayed = lastPlayed.map((lastPlayedItem) => {
      const currentFolder = folders.find(
        (folder) => folder.path === lastPlayedItem.path,
      );

      if (
        currentFolder &&
        currentFolder.seriesCount !== lastPlayedItem.seriesCount
      ) {
        hasUpdates = true;
        return {
          ...lastPlayedItem,
          seriesCount: currentFolder.seriesCount,
          name: currentFolder.name,
          type: currentFolder.type,
        };
      }

      return lastPlayedItem;
    });

    if (hasUpdates) {
      setLastPlayed(updatedLastPlayed);
      await LocalStorage.setItem(
        LAST_PLAYED_KEY,
        JSON.stringify(updatedLastPlayed),
      );
    }
  }

  async function preloadExistingThumbnails() {
    try {
      const existingFiles = await readdir(thumbnailCachePath).catch(() => []);
      const hashToPath: Record<string, string> = {};

      for (const file of existingFiles) {
        if (file.endsWith(".jpg")) {
          const fullPath = join(thumbnailCachePath, file);
          hashToPath[file.replace(".jpg", "")] = fullPath;
        }
      }

      const newThumbnails: Record<string, string> = { ...thumbnails };

      for (const folder of folders) {
        if (!newThumbnails[folder.path]) {
          const videoFile = await findFirstVideoFile(folder.path);
          if (videoFile) {
            const hash = createHash("md5").update(videoFile).digest("hex");
            if (hashToPath[hash]) {
              newThumbnails[folder.path] = hashToPath[hash];
            }
          }
        }
      }

      if (Object.keys(newThumbnails).length > Object.keys(thumbnails).length) {
        setThumbnails(newThumbnails);
        await saveThumbnailsCache(newThumbnails);
      }
    } catch (error) {
      console.error("Error preloading thumbnails:", error);
    }
  }

  async function saveThumbnailsCache(thumbnailsData: Record<string, string>) {
    try {
      const cacheData: ThumbnailsCache = {
        thumbnails: thumbnailsData,
        lastUpdated: Date.now(),
      };
      await LocalStorage.setItem(
        THUMBNAILS_CACHE_KEY,
        JSON.stringify(cacheData),
      );
    } catch (error) {
      console.error("Error saving thumbnail cache:", error);
    }
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

      const BATCH_SIZE = 8;
      const folders: MediaFolder[] = [];

      for (let i = 0; i < directories.length; i += BATCH_SIZE) {
        const batch = directories.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (dir) => {
          const folderPath = join(directory, dir.name);
          const seriesCount = await countVideoFiles(folderPath);
          const folderStat = await stat(folderPath).catch(() => null);

          return {
            name: dir.name,
            path: folderPath,
            type,
            seriesCount,
            lastModified: folderStat?.mtime.getTime() || 0,
          };
        });

        const batchResults = await Promise.all(batchPromises);
        folders.push(...batchResults);
      }

      return folders;
    } catch (error) {
      console.error(`Error loading ${type} folders:`, error);
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

  async function loadMediaFolders() {
    try {
      await refreshFolders();
    } catch (error) {
      console.error("Error loading folders:", error);
      setIsLoading(false);
    }
  }

  async function refreshFolders() {
    try {
      setIsRefreshing(true);
      const freshFolders = await loadFreshFolders();
      setFolders(freshFolders);
      // НЕ меняем isLoading здесь, чтобы избежать мигания
    } catch (error) {
      console.error("Error refreshing folders:", error);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function forceRefresh() {
    try {
      setIsRefreshing(true);

      // Загружаем свежие данные
      const freshFolders = await loadFreshFolders();

      if (freshFolders.length > 0) {
        setFolders(freshFolders);
        setHasInitialData(true);

        showToast({
          style: Toast.Style.Success,
          title: "Данные обновлены",
          message: `Загружено ${freshFolders.length} папок`,
        });
      } else {
        showToast({
          style: Toast.Style.Failure,
          title: "Ошибка обновления",
          message: "Папки не найдены",
        });
      }
    } catch (error) {
      console.error("Force refresh failed:", error);
      showToast({
        style: Toast.Style.Failure,
        title: "Ошибка обновления",
        message: error instanceof Error ? error.message : "Неизвестная ошибка",
      });
    } finally {
      setIsRefreshing(false);
    }
  }

  async function clearAllCache() {
    try {
      await LocalStorage.removeItem(THUMBNAILS_CACHE_KEY);

      // Сбрасываем состояние
      setThumbnails({});
      setFolders([]);
      setHasInitialData(false);
      setIsLoading(true);

      // Перезагружаем
      setTimeout(async () => {
        const freshFolders = await loadFreshFolders();
        setFolders(freshFolders);
        setHasInitialData(true);
        setIsLoading(false);
      }, 100);

      showToast({
        style: Toast.Style.Success,
        title: "Кеш очищен",
        message: "Миниатюры удалены, папки перезагружены",
      });
    } catch (error) {
      console.error("Clear cache failed:", error);
      showToast({
        style: Toast.Style.Failure,
        title: "Ошибка очистки",
        message: error instanceof Error ? error.message : "Неизвестная ошибка",
      });
    }
  }

  async function refreshFoldersSilent() {
    try {
      const freshFolders = await loadFreshFolders();

      if (freshFolders.length > 0) {
        setFolders(freshFolders);
        setHasInitialData(true);
        await syncLastPlayedWithFolders();
      }
    } catch (error) {
      console.error("Error refreshing folders:", error);
    }
  }

  const handleItemVisible = useCallback(
    (path: string) => {
      if (visibleItemsRef.current.has(path) || thumbnails[path]) return;

      visibleItemsRef.current.add(path);

      const checkThumbnail = async () => {
        if (thumbnails[path]) return;

        const videoFile = await findFirstVideoFile(path);
        if (videoFile) {
          const hash = createHash("md5").update(videoFile).digest("hex");
          const thumbnailFile = `${hash}.jpg`;
          const thumbnailPath = join(thumbnailCachePath, thumbnailFile);

          if (existsSync(thumbnailPath)) {
            setThumbnails((prev) => {
              if (prev[path]) return prev;
              const updated = { ...prev, [path]: thumbnailPath };
              saveThumbnailsCache(updated);
              return updated;
            });
          } else {
            thumbnailQueue.add(path, (generatedPath) => {
              setThumbnails((prev) => {
                if (prev[path]) return prev;
                const updated = { ...prev, [path]: generatedPath };
                saveThumbnailsCache(updated);
                return updated;
              });
            });
          }
        }
      };

      checkThumbnail();
    },
    [thumbnails],
  );

  async function playMediaFolder(folder: MediaFolder) {
    const savePromise = saveLastPlayed(folder);

    try {
      const videoFile = await findFirstVideoFile(folder.path);
      if (!videoFile) throw new Error("No video files found in folder");

      let args: string[] = [];
      if (folder.type === "anime") {
        args = animeArguments ? animeArguments.split(" ").filter(Boolean) : [];
      } else if (folder.type === "film") {
        args = filmsArguments ? filmsArguments.split(" ").filter(Boolean) : [];
      } else if (folder.type === "series") {
        args = seriesArguments
          ? seriesArguments.split(" ").filter(Boolean)
          : [];
      }

      const child = spawn("mpv", [videoFile, ...args], { stdio: "ignore" });
      child.unref();

      const [,] = await Promise.all([savePromise, closeMainWindow()]);
    } catch (error) {
      await savePromise;
      showToast({
        style: Toast.Style.Failure,
        title: "Error preparing to play video",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  function getSeriesDeclension(count: number): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) return "серий";
    if (lastDigit === 1) return "серия";
    if (lastDigit >= 2 && lastDigit <= 4) return "серии";
    return "серий";
  }

  function getRussianDeclension(
    count: number,
    one: string,
    two: string,
    five: string,
  ): string {
    let n = Math.abs(count) % 100;
    if (n >= 5 && n <= 20) {
      return five;
    }
    n %= 10;
    if (n === 1) {
      return one;
    }
    if (n >= 2 && n <= 4) {
      return two;
    }
    return five;
  }

  function formatLastPlayedTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0)
      return `${days} ${getRussianDeclension(days, "день", "дня", "дней")} назад`;
    if (hours > 0)
      return `${hours} ${getRussianDeclension(hours, "час", "часа", "часов")} назад`;
    if (minutes > 0)
      return `${minutes} ${getRussianDeclension(minutes, "минута", "минуты", "минут")} назад`;
    return "только что";
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
          try {
            await rm(thumbnailPath);
          } catch (error) {
            console.error("Error deleting thumbnail file:", error);
          }
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
            onAction={() => playMediaFolder(folder)}
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

  const typeDisplayNames: { [key: string]: string } = {
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

  // Компонент элемента сетки с ленивой загрузкой
  const GridItemWithLazyThumbnail = useCallback(
    ({
      folder,
      isLastPlayed = false,
    }: {
      folder: MediaFolder | LastPlayedMedia;
      isLastPlayed?: boolean;
    }) => {
      const hasExistingThumbnail = Boolean(thumbnails[folder.path]);

      useEffect(() => {
        if (!hasExistingThumbnail) {
          handleItemVisible(folder.path);
        }
      }, [folder.path, hasExistingThumbnail]);

      const subtitle = useMemo(() => {
        if (folder.type !== "film") {
          // Теперь folder.seriesCount уже актуальный из folders
          return `${folder.seriesCount} ${getSeriesDeclension(folder.seriesCount)}`;
        }
        return isLastPlayed && "lastPlayedAt" in folder
          ? formatLastPlayedTime(folder.lastPlayedAt)
          : undefined;
      }, [folder, isLastPlayed]);

      return (
        <Grid.Item
          key={isLastPlayed ? (folder as LastPlayedMedia).id : folder.path}
          title={folder.name}
          subtitle={subtitle}
          content={
            thumbnails[folder.path]
              ? `file://${thumbnails[folder.path]}`
              : getIconForType(folder.type)
          }
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
      isLoading={isLoading && !hasInitialData}
      searchBarPlaceholder="Поиск тайтлов..."
      columns={5}
      onSearchTextChange={setSearchText}
      searchText={searchText}
      navigationTitle={isRefreshing ? "Обновление..." : "MPV Launcher"}
    >
      {sortedLastPlayed.length > 0 && !debouncedSearch && (
        <Grid.Section title="Продолжить просмотр">
          {sortedLastPlayed.map((item) => {
            // Берем актуальные данные из folders
            const actualFolder = folders.find((f) => f.path === item.path);
            if (!actualFolder) return null; // Не показываем если папка не найдена

            const folderWithLastPlayedData = {
              ...actualFolder, // Все актуальные данные из folders
              id: item.id, // Сохраняем id для key
              lastPlayedAt: item.lastPlayedAt, // Сохраняем время последнего просмотра
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

      {["anime", "series", "film"].map((type) => {
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
