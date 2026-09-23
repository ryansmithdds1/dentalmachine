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
3. **Node.js 18 or newer** from nodejs.org.
4. **The imaging bridge.**
   1. In **Settings → Imaging bridges**, add the workstation (for example "Op 2").
   2. Choose **Tuxedo sensor** or **Jazz sensor**.
   3. Download `bridge-config.json` (its key is shown only once) and the bridge program.
   4. Put both files in one folder, for example `C:\DentalMachine`.

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
- `size` (optional): the sensor size, for example `"2"`, also recorded with each image.
- `command` (optional): where NAPS2 is installed, if it isn't in `C:\Program Files\NAPS2`.

Start the bridge with `node dental-machine-bridge.mjs bridge-config.json` (or as a Windows startup task). The window
should say `Sensor: Tuxedo sensor (<device name>)`.

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
