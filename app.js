const TEST_MODE = false;

// Helbra als Startpunkt
const TEST_LAT = 51.5576;
const TEST_LNG = 11.4924;

// Aufdeckungs-Einstellungen
const DISCOVERY_RADIUS = 60;      // Meter
const REVEAL_STEP_METERS = 20;    // Abstand zwischen Reveal-Punkten

// Karte erstellen
const map = L.map('map', {
    maxZoom: 19,
    zoomSnap: 0.5,
    zoomDelta: 0.5
}).setView([TEST_LAT, TEST_LNG], 14);

// OpenStreetMap Layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

let userMarker = null;
let routePoints = [];
let routeLine = null;
let lastRevealPoint = null;
let discoveredAreas = [];
let discoveredPoints = [];
let lastPositionTime = null;
let currentSpeedKmh = 0;
const speedInfoEl = document.getElementById("speedInfo");
let lastDrawTime = 0;
const DRAW_INTERVAL = 100; // ms (10 FPS reicht locker)
const STATIONARY_SPEED_THRESHOLD = 1.5; // km/h
const STATIONARY_DISTANCE_THRESHOLD = 8; // Meter
let lastAcceptedPoint = null;
let smoothedPoint = null;

const canvas = document.getElementById("fogCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// Marker/Route aktualisieren
function updateMarkerAndRoute(lat, lng) {
    const newPoint = [lat, lng];

    if (!userMarker) {
    map.setView(newPoint, 16);
    }

    if (userMarker) {
        userMarker.setLatLng(newPoint);
    } else {
        userMarker = L.marker(newPoint).addTo(map);
    }

    routePoints.push(newPoint);

    if (routeLine) {
        routeLine.setLatLngs(routePoints);
    } else {
        routeLine = L.polyline(routePoints).addTo(map);
    }
}

// Nur zeichnen
function drawRevealCircle(lat, lng) {
    // Debug-Kreise deaktiviert
}

// Zeichnen + speichern
function addRevealCircle(lat, lng) {
    drawRevealCircle(lat, lng);
    discoveredPoints.push([lat, lng]);
    saveProgress();
}

// Zwischenpunkte setzen, damit keine Lücken entstehen
function revealPath(fromLat, fromLng, toLat, toLng) {
    const distance = map.distance([fromLat, fromLng], [toLat, toLng]);

    if (distance < 1) {
        addRevealCircle(toLat, toLng);
        return;
    }

    const dynamicStep = getDynamicRevealStep(currentSpeedKmh);
    const steps = Math.max(1, Math.ceil(distance / dynamicStep));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const lat = fromLat + (toLat - fromLat) * t;
        const lng = fromLng + (toLng - fromLng) * t;
        addRevealCircle(lat, lng);
    }
}

function updateSpeedDisplay(speedKmh) {
    speedInfoEl.textContent = `Speed: ${speedKmh.toFixed(1)} km/h`;
}

function estimateSpeedKmh(lat, lng, timestampMs) {
    if (!lastRevealPoint || !lastPositionTime) return 0;

    const distanceMeters = map.distance(lastRevealPoint, [lat, lng]);
    const deltaSeconds = (timestampMs - lastPositionTime) / 1000;

    if (deltaSeconds <= 0) return 0;

    const metersPerSecond = distanceMeters / deltaSeconds;
    return metersPerSecond * 3.6;
}

function getDynamicRevealStep(speedKmh) {
    if (speedKmh < 8) return 15;       // zu Fuß
    if (speedKmh < 25) return 25;      // Joggen/Fahrrad
    if (speedKmh < 80) return 40;      // Stadt/Landstraße
    if (speedKmh < 180) return 80;     // Autobahn/Zug
    return 150;                        // sehr schnell / Flugzeug grob
}

function isOutlierJump(lat, lng, speedKmh) {
    if (!lastAcceptedPoint || !lastPositionTime) return false;

    const now = Date.now();
    const deltaSeconds = (now - lastPositionTime) / 1000;
    if (deltaSeconds <= 0) return false;

    const distanceMeters = map.distance(lastAcceptedPoint, [lat, lng]);
    const estimatedKmh = (distanceMeters / deltaSeconds) * 3.6;

    // sehr grobe Obergrenzen je nach Modus
    if (speedKmh < 15 && estimatedKmh > 80) return true;
    if (speedKmh < 80 && estimatedKmh > 250) return true;
    if (estimatedKmh > 1200) return true;

    return false;
}

function smoothPosition(lat, lng, speedKmh) {
    if (!smoothedPoint) {
        smoothedPoint = [lat, lng];
        return smoothedPoint;
    }

    let alpha = 0.35; // Standard: eher ruhig

    if (speedKmh < 10) alpha = 0.25;       // zu Fuß: stärker glätten
    else if (speedKmh < 50) alpha = 0.35;  // langsam/mittel
    else if (speedKmh < 120) alpha = 0.5;  // Auto/Landstraße
    else alpha = 0.65;                     // sehr schnell: direkter folgen

    const [oldLat, oldLng] = smoothedPoint;

    const newLat = oldLat + (lat - oldLat) * alpha;
    const newLng = oldLng + (lng - oldLng) * alpha;

    smoothedPoint = [newLat, newLng];
    return smoothedPoint;
}

function updatePosition(lat, lng, speedMps = null) {
    const now = Date.now();

    let speedKmh = 0;

    if (typeof speedMps === "number" && !Number.isNaN(speedMps) && speedMps >= 0) {
        speedKmh = speedMps * 3.6;
    } else {
        speedKmh = estimateSpeedKmh(lat, lng, now);
    }

    currentSpeedKmh = speedKmh;
    updateSpeedDisplay(currentSpeedKmh);

    if (isOutlierJump(lat, lng, currentSpeedKmh)) {
        console.log("Ausreißer ignoriert:", lat, lng, currentSpeedKmh.toFixed(1));
        return;
    }

    if (lastAcceptedPoint) {
        const driftDistance = map.distance(lastAcceptedPoint, [lat, lng]);

        if (
            currentSpeedKmh < STATIONARY_SPEED_THRESHOLD &&
            driftDistance < STATIONARY_DISTANCE_THRESHOLD
        ) {
            console.log("Stillstand/Drift ignoriert:", driftDistance.toFixed(1), "m");
            return;
        }
    }

    const [smoothLat, smoothLng] = smoothPosition(lat, lng, currentSpeedKmh);

    updateMarkerAndRoute(smoothLat, smoothLng);

    if (!lastRevealPoint) {
        addRevealCircle(smoothLat, smoothLng);
        lastRevealPoint = [smoothLat, smoothLng];
        lastAcceptedPoint = [lat, lng];
        lastPositionTime = now;
    } else {
        const [lastLat, lastLng] = lastRevealPoint;
        revealPath(lastLat, lastLng, smoothLat, smoothLng);
        lastRevealPoint = [smoothLat, smoothLng];
        lastAcceptedPoint = [lat, lng];
        lastPositionTime = now;
    }

    const nowDraw = Date.now();
    if (nowDraw - lastDrawTime > DRAW_INTERVAL) {
        drawFog();
        lastDrawTime = nowDraw;
    }

    console.log("Position:", lat, lng, "Speed km/h:", currentSpeedKmh.toFixed(1));
}

if (TEST_MODE) {
    const testRoute = [
        [51.5576, 11.4924],
        [51.5580, 11.4930],
        [51.5585, 11.4940],
        [51.5590, 11.4950],
        [51.5595, 11.4960]
    ];

    let i = 0;

    function playTestRoute() {
        if (i < testRoute.length) {
            const [lat, lng] = testRoute[i];
            updatePosition(lat, lng, 5);
            i++;
            setTimeout(playTestRoute, 1000);
        }
    }

    loadProgress();
    playTestRoute();
    console.log("TEST MODE aktiv");
} else {
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const speed = position.coords.speed;
                updatePosition(lat, lng, speed);
            },
            (error) => {
                console.error("GPS Fehler:", error);
                alert("Standort konnte nicht abgerufen werden. Fehlercode: " + error.code);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 5000,
                timeout: 15000
            }
        );
    } else {
        alert("Geolocation wird nicht unterstützt.");
    }
}

function saveProgress() {
    localStorage.setItem("fow_points", JSON.stringify(discoveredPoints));
}

function loadProgress() {
    const data = localStorage.getItem("fow_points");

    if (!data) return;

    const points = JSON.parse(data);

    for (const [lat, lng] of points) {
        drawRevealCircle(lat, lng);
    }

    discoveredPoints = points;
    drawFog();
}

function resetProgress() {
    localStorage.removeItem("fow_points");

    for (const area of discoveredAreas) {
        map.removeLayer(area);
    }

    discoveredAreas = [];
    discoveredPoints = [];
    lastRevealPoint = null;
    lastAcceptedPoint = null;
    smoothedPoint = null;

    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }

    routePoints = [];

    if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
    }

    if (TEST_MODE) {
        location.reload();
    }
}

document.getElementById("resetButton").addEventListener("click", resetProgress);

function metersToPixels(lat, lng, meters) {
    const point1 = map.latLngToContainerPoint([lat, lng]);
    const latOffset = meters / 111320;
    const point2 = map.latLngToContainerPoint([lat + latOffset, lng]);
    return Math.abs(point2.y - point1.y);
}

function drawFog() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // kompletten Nebel zeichnen
    ctx.fillStyle = "rgba(0, 0, 0, 1)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Löcher ausschneiden
    ctx.globalCompositeOperation = "destination-out";

    for (const [lat, lng] of discoveredPoints) {
        const point = map.latLngToContainerPoint([lat, lng]);
        const radiusPx = metersToPixels(lat, lng, DISCOVERY_RADIUS);
        const softRadiusPx = radiusPx * 1.35;
        const gradient = ctx.createRadialGradient(
            point.x, point.y, 0,
            point.x, point.y, softRadiusPx
        );

        gradient.addColorStop(0, "rgba(0,0,0,1)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");

        ctx.fillStyle = gradient;

        ctx.beginPath();
        ctx.arc(point.x, point.y, softRadiusPx, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
}

map.on("move", drawFog);


resetProgress
