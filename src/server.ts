import express, {Request, Response} from "express";
import os from "os";
import fs from "fs";
import path from "path";
import {execSync} from "child_process";

type LoadAvg = { "1m": number; "5m": number; "15m": number };
type MemInfo = {
    total_gb: number;
    used_gb: number;
    avail_gb: number;
    used_pct: number;
};
type DiskInfo = {
    size_gb: number;
    used_gb: number;
    avail_gb: number;
    use_pct: string;
};

type SpecsResponse = {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
    model: string | null;
    cpu_count: number | null;
    node: string;
};

type MetricsResponse = {
    time: string;
    cpu_temp_c: number | null;
    cpu_freq_mhz: number | null;
    loadavg: LoadAvg | null;
    mem: MemInfo | null;
    disk_root: DiskInfo | null;
    uptime_sec: number | null;
};

const app = express();
const port = Number(process.env.PORT ?? 3000);

const publicDir = path.join(process.cwd(), "public");
app.use(express.static(publicDir));

function safeRead(pathname: string): string | null {
    try {
        return fs.readFileSync(pathname, "utf8");
    } catch {
        return null;
    }
}

function getCpuTempC(): number | null {
    const raw = safeRead("/sys/class/thermal/thermal_zone0/temp");
    if (!raw) return null;
    const milli = Number(raw.trim());
    if (!Number.isFinite(milli)) return null;
    return milli / 1000;
}

function getCpuFreqMHz(): number | null {
    // Many Pi OS builds expose kHz here
    const raw = safeRead("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq");
    if (!raw) return null;
    const khz = Number(raw.trim());
    if (!Number.isFinite(khz)) return null;
    return khz / 1000;
}

function getModel(): string | null {
    const raw = safeRead("/proc/device-tree/model");
    if (!raw) return null;
    return raw.replace(/\u0000/g, "").trim();
}

function getLoadAvg(): LoadAvg | null {
    const raw = safeRead("/proc/loadavg");
    if (!raw) return null;
    const [a, b, c] = raw.trim().split(/\s+/);
    const n1 = Number(a), n5 = Number(b), n15 = Number(c);
    if (![n1, n5, n15].every(Number.isFinite)) return null;
    return {"1m": n1, "5m": n5, "15m": n15};
}

function getMem(): MemInfo | null {
    const raw = safeRead("/proc/meminfo");
    if (!raw) return null;

    const map: Record<string, number> = {};
    for (const line of raw.split("\n")) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) map[m[1]] = Number(m[2]);
    }

    const totalKB = map["MemTotal"];
    const availKB = map["MemAvailable"];
    if (!Number.isFinite(totalKB) || !Number.isFinite(availKB)) return null;

    const usedKB = totalKB - availKB;

    return {
        total_gb: totalKB / 1024 / 1024,
        used_gb: usedKB / 1024 / 1024,
        avail_gb: availKB / 1024 / 1024,
        used_pct: (usedKB / totalKB) * 100,
    };
}

function getDiskRoot(): DiskInfo | null {
    try {
        const out = execSync("df -k /", {encoding: "utf8"}).trim().split("\n");
        if (out.length < 2) return null;
        const parts = out[1].split(/\s+/);
        const sizeKB = Number(parts[1]);
        const usedKB = Number(parts[2]);
        const availKB = Number(parts[3]);
        const usePct = parts[4];

        if (![sizeKB, usedKB, availKB].every(Number.isFinite)) return null;

        return {
            size_gb: sizeKB / 1024 / 1024,
            used_gb: usedKB / 1024 / 1024,
            avail_gb: availKB / 1024 / 1024,
            use_pct: usePct,
        };
    } catch {
        return null;
    }
}

function getUptimeSec(): number | null {
    const raw = safeRead("/proc/uptime");
    if (!raw) return null;
    const first = raw.split(/\s+/)[0];
    const sec = Number(first);
    return Number.isFinite(sec) ? sec : null;
}

function collectSpecs(): SpecsResponse {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        model: getModel(),
        cpu_count: os.cpus()?.length ?? null,
        node: process.version,
    };
}

function collectMetrics(): MetricsResponse {
    return {
        time: new Date().toISOString(),
        cpu_temp_c: getCpuTempC(),
        cpu_freq_mhz: getCpuFreqMHz(),
        loadavg: getLoadAvg(),
        mem: getMem(),
        disk_root: getDiskRoot(),
        uptime_sec: getUptimeSec(),
    };
}

app.get("/api/specs", (_req: Request, res: Response) => {
    res.json(collectSpecs());
});

app.get("/api/metrics", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(collectMetrics());
});

/**
 * Optional: Server-Sent Events stream
 * Client can connect to /api/stream and receive JSON every second.
 */
app.get("/api/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");

    const send = () => {
        const data = collectMetrics();
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send();
    const timer = setInterval(send, 1000);

    req.on("close", () => {
        clearInterval(timer);
    });
});

app.listen(port, "0.0.0.0", () => {
    console.log(`pi-monitor-ts running on http://0.0.0.0:${port}`);
});