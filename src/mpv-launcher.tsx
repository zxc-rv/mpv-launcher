import { List, ActionPanel, Action, showToast, Toast, getPreferenceValues, LocalStorage, popToRoot, closeMainWindow, Icon, confirmAlert, Alert, environment } from "@raycast/api";
import { useEffect, useState } from "react";
import { readdir, rm, stat, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { createHash } from "crypto";

const LAST_PLAYED_KEY = "last_played_media_v2";

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
}

interface LastPlayedMedia extends MediaFolder {
  id: string;
  lastPlayedAt: number;
}

const thumbnailCachePath = join(environment.supportPath, "thumbnails");

export default function Command() {
  const { animeDirectory, filmsDirectory, seriesDirectory, animeArguments, filmsArguments, seriesArguments } = getPreferenceValues<Preferences>();
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [lastPlayed, setLastPlayed] = useState<LastPlayedMedia[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function initialLoad() {
      await mkdir(thumbnailCachePath, { recursive: true });
      await loadLastPlayed();
      await loadMediaFolders();
    }
    initialLoad();
  }, []);

  async function loadLastPlayed() {
    try {
      const lastPlayedJson = await LocalStorage.getItem<string>(LAST_PLAYED_KEY);
      if (lastPlayedJson) {
        let lastPlayedData = JSON.parse(lastPlayedJson) as LastPlayedMedia[];

        const existenceChecks = await Promise.all(lastPlayedData.map((item) => stat(item.path).then(() => true).catch(() => false)));
        let existingLastPlayed = lastPlayedData.filter((_, index) => existenceChecks[index]);

        if (existingLastPlayed.length !== lastPlayedData.length) {
          await LocalStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(existingLastPlayed));
        }

        existingLastPlayed.forEach((item) => {
          generateThumbnail(item.path, (thumbnailPath) => {
            setThumbnails((prev) => ({ ...prev, [item.path]: thumbnailPath }));
          });
        });

        setLastPlayed(existingLastPlayed);
      }
    } catch (error) {
      console.error("Error loading last played:", error);
    }
  }

  async function saveLastPlayed(folder: MediaFolder) {
    const newItem: LastPlayedMedia = {
      ...folder,
      id: `${folder.path}-${Date.now()}`,
      lastPlayedAt: Date.now(),
    };

    const updatedLastPlayed = [newItem, ...lastPlayed.filter(item => item.path !== folder.path)].slice(0, 5);

    await LocalStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(updatedLastPlayed));
    setLastPlayed(updatedLastPlayed);
  }

  async function loadFoldersFromDirectory(directory: string, type: "anime" | "film" | "series"): Promise<MediaFolder[]> {
    try {
      const items = await readdir(directory, { withFileTypes: true });
      const folderPromises = items
        .filter((item) => item.isDirectory())
        .map(async (dir) => {
          const folderPath = join(directory, dir.name);
          let seriesCount = 0;
          try {
            const files = await readdir(folderPath);
            seriesCount = files.filter((file) => /\.(mp4|mkv|avi)$/i.test(file)).length;
          } catch (e) {
            // ignore if we can't read a subdirectory
          }
          return { name: dir.name, path: folderPath, type, seriesCount };
        });
      const folders = await Promise.all(folderPromises);
      folders.forEach((folder) => {
        generateThumbnail(folder.path, (thumbnailPath) => {
          setThumbnails((prev) => ({ ...prev, [folder.path]: thumbnailPath }));
        });
      });
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

  async function loadMediaFolders() {
    try {
      const [animeFolders, filmFolders, seriesFolders] = await Promise.all([
        loadFoldersFromDirectory(animeDirectory, "anime"),
        loadFoldersFromDirectory(seriesDirectory, "series"),
        loadFoldersFromDirectory(filmsDirectory, "film"),
      ]);

      const allFolders = [...animeFolders, ...filmFolders, ...seriesFolders].sort((a, b) => a.name.localeCompare(b.name));
      setFolders(allFolders);
      setIsLoading(false);
    } catch (error) {
      console.error("Error loading folders:", error);
      setIsLoading(false);
    }
  }

  async function generateThumbnail(folderPath: string, onThumbnailGenerated: (path: string) => void) {

    const videoFile = await findFirstVideoFile(folderPath);
    if (!videoFile) return undefined;

    const hash = createHash("md5").update(videoFile).digest("hex");
    const thumbnailFile = `${hash}.jpg`;
    const thumbnailPath = join(thumbnailCachePath, thumbnailFile);

    if (existsSync(thumbnailPath)) {
      onThumbnailGenerated(thumbnailPath);
      return;
    }

    const args = ['-i', videoFile, '-ss', '00:00:05', '-vframes', '1', '-f', 'image2', thumbnailPath];
    const ffmpeg = spawn("ffmpeg", args);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        onThumbnailGenerated(thumbnailPath);
      } else {
        console.error(`FFmpeg failed for ${videoFile} with code ${code}`);
      }
    });

    ffmpeg.on("error", (err) => {
      console.error(`Failed to start FFmpeg for ${videoFile}:`, err);
    });


  }

  async function findFirstVideoFile(folderPath: string): Promise<string | null> {
    try {
      const files = await readdir(folderPath);
      const videoFiles = files.filter((file) => /\.(mp4|mkv|avi)$/i.test(file)).sort((a, b) => a.localeCompare(b));
      return videoFiles.length > 0 ? join(folderPath, videoFiles[0]) : null;
    } catch (error) {
      console.error("Error finding video file:", error);
      return null;
    }
  }

  async function playMediaFolder(folder: MediaFolder) {
    await saveLastPlayed(folder);
    try {
      const videoFile = await findFirstVideoFile(folder.path);
      if (!videoFile) throw new Error("No video files found in folder");

      let args: string[] = [];
      if (folder.type === "anime") {
        args = animeArguments ? animeArguments.split(' ') : [];
      } else if (folder.type === "film") {
        args = filmsArguments ? filmsArguments.split(' ') : [];
      } else if (folder.type === "series") {
        args = seriesArguments ? seriesArguments.split(' ') : [];
      }

      const child = spawn("mpv", [videoFile, ...args], { detached: true });
      child.unref();

      await popToRoot();
      await closeMainWindow();
    } catch (error) {
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

  function getRussianDeclension(count: number, one: string, two: string, five: string): string {
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

    if (days > 0) return `${days} ${getRussianDeclension(days, 'день', 'дня', 'дней')} назад`;
    if (hours > 0) return `${hours} ${getRussianDeclension(hours, 'час', 'часа', 'часов')} назад`;
    if (minutes > 0) return `${minutes} ${getRussianDeclension(minutes, 'минута', 'минуты', 'минут')} назад`;
    return "только что";
  }

  async function deleteMediaFolder(folder: MediaFolder) {
    if (
      await confirmAlert({
        title: `Delete "${folder.name}"?`,
        message: "This action is permanent and cannot be undone.",
        icon: Icon.Trash,
        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
      })
    ) {
      try {
        await rm(folder.path, { recursive: true, force: true });
        showToast({ style: Toast.Style.Success, title: "Folder Deleted", message: `Removed "${folder.name}"` });

        const updatedLastPlayed = lastPlayed.filter((item) => item.path !== folder.path);
        await LocalStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(updatedLastPlayed));
        setLastPlayed(updatedLastPlayed);

        await loadMediaFolders();
      } catch (error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Deletion Failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  const mediaActions = (folder: MediaFolder, isLastPlayed = false) => (
    <ActionPanel>
      <ActionPanel.Section>
        <Action title={isLastPlayed ? "Продолжить просмотр" : "Начать просмотр"} onAction={() => playMediaFolder(folder)} icon={Icon.Play} />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action.OpenInBrowser title="Открыть директорию" url={folder.path} icon={Icon.Folder} />
        <Action
          title="Удалить директорию"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          onAction={() => deleteMediaFolder(folder)}
          shortcut={{ modifiers: ["ctrl"], key: "d" }}
        />
      </ActionPanel.Section>
    </ActionPanel>
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

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Поиск тайтлов...">
      {lastPlayed.length > 0 && (
        <List.Section title="Продолжить просмотр">
          {lastPlayed.map((item) => (
            <List.Item
              key={item.id}
              title={item.name}
              subtitle={formatLastPlayedTime(item.lastPlayedAt)}
              icon={thumbnails[item.path] ? `file://${thumbnails[item.path]}` : getIconForType(item.type)}
              accessories={item.type !== 'film' ? [{ text: `${item.seriesCount} ${getSeriesDeclension(item.seriesCount)}` }] : []}
              actions={mediaActions(item, true)}
            />
          ))}
        </List.Section>
      )}
      {["anime", "series", "film"].map((type) => (
        <List.Section key={type} title={typeDisplayNames[type]}>
          {folders
            .filter((f) => f.type === type)
            .map((folder) => (
              <List.Item
                key={folder.path}
                title={folder.name}
                icon={thumbnails[folder.path] ? `file://${thumbnails[folder.path]}` : getIconForType(folder.type)}
                accessories={folder.type !== 'film' ? [{ text: `${folder.seriesCount} ${getSeriesDeclension(folder.seriesCount)}` }] : []}
                actions={mediaActions(folder)}
              />
            ))}
        </List.Section>
      ))}
    </List>
  );
}
