# Plex Torrent Automation Handoff

This document details the configuration for your dedicated Mini PC media server (Intel N100) using your **500GB external USB SSD** as a temporary download/playback cache with an automated "watch-and-delete" configuration.

## 📁 Storage Architecture (External USB SSD)
Map your external drive letter (e.g., `D:\` or `E:\`) to use this exact folder layout. This setup enables quick directory changes so your drive doesn't choke copying massive files.

```text
📁 D:\ (500GB USB SSD)
└── 📁 data/
    ├── 📁 torrents/      <-- qBittorrent default download path
    │   ├── 📁 tv/
    │   └── 📁 movies/
    └── 📁 media/         <-- The folder your Plex Libraries point to
        ├── 📁 tv/
        └── 📁 movies/
```

## 🛠️ Software Deployment Matrix
Install all three utilities as **Windows Services** to ensure they launch silently in the background on startup without needing your laptop active.

| Application | Role | Default Web Address |
| :--- | :--- | :--- |
| **Sonarr** | TV Show Automator | `http://localhost:8989` |
| **Radarr** | Movie Automator | `http://localhost:7878` |
| **Prowlarr** | Indexer/Search Aggregator | `http://localhost:9696` |
| **qBittorrent** | Torrent Client | Configured via Web UI (`http://localhost:8080`) |

---

## ⚙️ Step-by-Step Configuration Pipeline

### Step 1: Secure qBittorrent Web UI
1. Open **qBittorrent** -> **Tools** -> **Options** -> **Web UI**.
2. Check **Web User Interface (Web UI)**.
3. Set your username and password. Note the port number (Default: `8080`).

### Step 2: Configure Prowlarr (Search Hub)
1. Navigate to `http://localhost:9696`.
2. Go to **Settings** -> **General** and copy your **API Key**.
3. Go to **Indexers** -> **Add New** (+) -> add your preferred public torrent indexers (e.g., *1337x, TorrentGalaxy, YTS*).

### Step 3: Interconnect Prowlarr to Sonarr & Radarr
1. Inside **Prowlarr**, navigate to **Settings** -> **Apps** -> Click **+**.
2. Select **Sonarr**. Input `http://localhost:8989`. 
3. Open a tab for **Sonarr** (`http://localhost:8989`) -> **Settings** -> **General** -> Copy Sonarr's API Key and paste it into Prowlarr. Click **Test** and **Save**.
4. Repeat this exact process for **Radarr** using port `7878`.
*Prowlarr will now automatically push all torrent search engines to both managers.*

### Step 4: Link Download Automation & Categories
1. In **Sonarr**, go to **Settings** -> **Download Clients** -> Click **+** -> Select **qBittorrent**.
2. Host: `localhost` | Port: `8080` | Input your Web UI credentials.
3. **CRUCIAL:** Under **Category**, type `tv-sonarr`. Click **Save**.
4. In **Radarr**, repeat the exact steps, but set the **Category** to `movies-radarr`.

---

## 🧹 The "Zero-Maintenance" Auto-Clean Strategy
Since you are working with a **500GB SSD**, you must instruct the applications to recycle space automatically once you finish watching content downstairs.

### Phase A: Plex Self-Vaporization
1. Open Plex on your browser. Navigate to your **TV Shows Library**.
2. Hover over a cycling show, click the **Three Dots (...)** -> **Manage Library** -> **Advanced** (or **Edit** -> **Advanced**).
3. Set **Delete Episodes After Playing** to **After a day** (or *After a week*).
4. *Leave your classic libraries (like The Bear) set to **Never Delete**.*

### Phase B: Prevent Automation Loop Back
1. Open **Sonarr** and **Radarr**.
2. Go to **Settings** -> **Media Management** -> Scroll to **File Management**.
3. Check the box for **Unmonitor Deleted Episodes/Movies**.
4. *This tells the automation stack to stop looking for new torrents when Plex auto-deletes a file you just finished watching.*

---

## 🔒 Recommended VPN Integration
To prevent your ISP from tracking your torrent traffic without choking your remote dashboard access:
* Use a provider like **Mullvad** or **ProtonVPN** on the Mini PC.
* Bind qBittorrent exclusively to the VPN network interface (**Tools** -> **Options** -> **Advanced** -> **Network Interface**) so downloads instantly freeze if the VPN drops.
