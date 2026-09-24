# Setting up Tuxedo and Jazz sensors

Dental Machine can take x-rays straight from the sensor into the patient's chart. There's no separate
imaging program to open. The chair-side computer runs the **imaging bridge**. For each exposure, the bridge asks the sensor's
**TWAIN driver** for an image through the free **NAPS2** scanning app, and sends the image to the chart.

Both brands supply a TWAIN driver: Tuxedo sensors (Denterprise; formerly LED/Apteryx) and Jazz Imaging sensors. This is the
standard way for dental software to talk to a sensor it doesn't have a direct integration with. It is also how other
practice-management systems work with these sensors.

> **Test at the office first.** The capture path has been tested end to end with a simulated sensor, not with a
> physical Tuxedo or Jazz sensor. Before a patient day, do the checks under "First test" on each operatory PC.

## What each operatory PC needs

1. **The sensor's own driver and TWAIN driver.** Install them from the vendor:
   - Tuxedo: *tuxedoimaging.com → Support & Downloads* (the Tuxedo TWAIN driver is free).
   - Jazz: Jazz Imaging support (the TWAIN driver comes with Jazz Classic; ask Jazz support if you only need TWAIN).
   Plug the sensor in and let Windows finish installing it.
2. **NAPS2**, the free scanning app, from naps2.com. Install it with the default options. NAPS2 7 and newer can use both
   32- and 64-bit TWAIN drivers.
3. **The imaging bridge.**
   1. In **Settings → Imaging bridges**, press **Set up a workstation** and name it (for example "Op 2").
   2. Pick any imaging programs on that PC (or none), then choose **Tuxedo sensor** or **Jazz sensor**.
   3. Download the install package. It holds the workstation's key, which is shown only once.
   4. On the PC, unzip it and double-click `install.cmd`. The installer adds Node.js if it's missing, installs the
      bridge in `C:\DentalMachine`, and starts it now and at every sign-in. See [imaging-bridges.md](imaging-bridges.md).

## Settings file

The downloaded `bridge-config.json` already has the sensor section:

```json
"sensor": { "preset": "tuxedo", "exposure": { "kvp": 70, "ma": 7 } }
```

- `preset`: `"tuxedo"`, `"jazz"` or `"twain"` (any other TWAIN sensor). The bridge asks NAPS2 for the list of TWAIN
  devices and picks the one whose name matches the brand.
- `device` (optional): the exact TWAIN name, when a PC has more than one sensor or the name doesn't contain the brand.
  To see the names, run `node dental-machine-bridge.mjs bridge-config.json --list-sensors`.
- `exposure`: the x-ray head's usual settings. They are recorded on every image for the radiation log. Staff can
  correct a single image in the viewer.
- `size` (optional): the sensor size (`0`, `1` or `2`). It's recorded with each image, and until the sensor is calibrated it
  gives an approximate mm scale (shown with "≈").
- `pixelSize` (optional): the sensor's pixel size in micrometres, from its spec sheet (for example `20`). With this,
  measurements are in mm straight away.
- `command` (optional): where NAPS2 is installed, if it isn't in `C:\Program Files\NAPS2`.

The installer starts the bridge for you. To run it by hand instead, use `node dental-machine-bridge.mjs bridge-config.json`.
Its window (or `C:\DentalMachine\bridge.log`) should say `Sensor: Tuxedo sensor (<device name>)`.

## First test

1. In **Settings → Imaging bridges**, the workstation shows **Online** and the sensor name.
2. Press **Test sensor** and take one exposure (or trigger the sensor while it's covered). The steps turn green and the
   test picture appears. Nothing is saved to any chart.
3. Open a test patient, go to **Documents & x-rays**, pick **This computer**, and press **Capture from Tuxedo sensor**
   with **4 bitewings**. The imaging studio opens with the first spot glowing. Take four exposures. Each one should land
   in the next spot within a few seconds.
4. Click an empty spot to aim the next exposure there. Hover over an image and press **Retake** to replace it. The first
   image stays in the chart and is marked as retaken.

If the TWAIN driver opens its own capture window, set it to capture automatically (no preview or confirm step) in the
driver's options. That way each exposure goes straight through.

## Measuring in mm

Images from a TWAIN driver usually don't say how big a pixel is (DICOM files from imaging software do). Measurements
use the best scale available, and the viewer says which one it used:

1. **Calibrated.** Open any x-ray from that sensor, choose **Calibrate**, and draw along something of known length. A
   ruler or calibration target works, as does the length of a file or an implant you know. Enter the length in mm, then
   answer **Yes** to "Use this scale for every future x-ray from this sensor?". This is the most accurate, and you only
   do it once per sensor.
2. **Pixel size** from `pixelSize` in the settings file.
3. **≈ Estimated** from `size` (the typical active area of that sensor size). Good enough for a rough look; calibrate
   before using it for anything that matters.

Lengths, canal lengths (click along the canal, double-click to finish) and angles all use the scale.

## Getting a clear picture from any sensor

X-rays open with **Clarity**: auto levels, local contrast (CLAHE), light noise reduction and sharpening. This evens out
differences between sensors and exposures. Press **1** for the untouched image, or use the **Caries**, **Endo** and
**Perio** presets. The sliders fine-tune each step. **Save** keeps an image's settings; the original file never
changes. "Open x-rays with" in the adjust panel sets the default for that computer.

## Intraoral camera

Almost every intraoral camera connects as a standard USB camera, so it runs in the browser with no bridge or driver
beyond the camera's own. In a patient's **Documents & x-rays**, press **Intraoral camera**, or press **Camera** in the
imaging studio.

- Choose the camera once per computer; it's remembered.
- Capture with the on-screen button, the **Space** key, or the camera's own button. Most handpiece buttons send a key
  press; press **Button: …**, then the camera's button, and it's learned.
- Enter a tooth number to file the photo against that tooth. **Mirror** and **Upper** flip the picture for mirror and
  upper-arch shots. **Freeze** holds the picture so you can check it before capturing.
- Photos are saved to the chart straight away, tagged "intraoral". When a **Photo series** mount is open, they fill its
  spots in order.

Cameras only work over https (or on the server computer itself), which the hosted app always uses. Cameras with a
TWAIN-only driver can go through the bridge like a sensor, using `"preset": "twain"`.

## Using the vendor's own capture software instead

If you'd rather keep capturing in the sensor's own software (Tuxedo's, Apteryx XrayVision, Jazz Classic…), leave out
the `sensor` section. Set that program to export or auto-save to a folder, and watch the folder:

```json
"watch": [{ "folder": "C:\\Jazz\\Export", "category": "xray", "moveTo": "C:\\Jazz\\Export\\sent" }]
```

New images go to the patient opened from the chart on that computer. See the README section on imaging bridges.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| "No Tuxedo sensor among the TWAIN devices" in the bridge window | The TWAIN driver isn't installed, or its name has no "Tuxedo"/"Jazz" in it. Run `--list-sensors` and put the exact name in `"device"`. |
| "couldn't run …NAPS2.Console.exe" | NAPS2 isn't installed where the bridge looks. Install it, or set `"command"` to its `NAPS2.Console.exe`. |
| Test sensor: "No image from the sensor" | Check the sensor is plugged in and shows in the vendor's own software. Close other programs that are holding the sensor (only one program can use it at a time). |
| The workstation shows Offline | The bridge isn't running on that PC, or that PC can't reach the Dental Machine address. |
| Images are very dark or washed out | Use the viewer presets (Caries, Endo, Perio, Auto) or the sliders. **Save** keeps the setting for that image. Check the x-ray head's exposure time for the sensor. |
