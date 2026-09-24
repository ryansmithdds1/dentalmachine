# Setting up an imaging workstation

The **imaging bridge** is a small program on each operatory PC. It does two things:

- **Open in DEXIS (etc.)** from the chart starts the imaging program with that patient.
- New x-rays and photos that the imaging program exports to a folder are filed in the patient's chart.

It can also take x-rays straight from a sensor. See [imaging-sensors.md](imaging-sensors.md).

## The quick way: the setup wizard

1. An administrator opens **Settings → Imaging bridges** and presses **Set up a workstation**.
2. **Workstation:** give it a name, for example "Op 2". Choose Windows unless the PC is a Mac or Linux machine.
3. **Imaging programs:** search the list and click every program installed on that PC. A **Program path** is
   only needed if the program isn't in its usual folder, or for the two "Other program" entries.
4. **Sensor (optional):** Tuxedo, Jazz, or another TWAIN sensor.
5. **Download:** press **Add workstation and download**. This adds the workstation and downloads
   `DentalMachine-Bridge-<name>.zip` at the same moment.

The zip holds the workstation's key. The key is shown only once, so the package can only be downloaded from the
wizard, in the first 30 minutes after the workstation is added. If you lose the zip, remove the workstation and
set it up again. Don't email the zip. Copy it to the PC on a USB stick or a shared folder, then delete the copy.

### On the PC (Windows)

1. Unzip the whole folder. Don't run anything from inside the zip.
2. Double-click **install.cmd** and answer **Yes** when Windows asks for permission. The installer then:
   - installs Node.js LTS if it's missing. It tries `winget` first. If that fails, it downloads the official
     installer from nodejs.org and checks it against nodejs.org's SHA-256 list. If both fail, it says so and
     stops. Then install the "LTS" version from nodejs.org and run install.cmd again.
   - copies the bridge to `C:\DentalMachine`. Only administrators and the signed-in person can open that
     folder, because it holds the key.
   - registers a **Scheduled Task** called "Dental Machine imaging bridge". The task starts the bridge, hidden,
     when that person signs in, and restarts it if it stops.
   - runs the bridge's setup check and prints the results (`OK`, `FAIL`, `NOTE`), then starts the bridge.
3. Open `SETUP.txt`. For each imaging program, set its export (or auto-export) folder to the one listed there,
   for example `C:\DentalMachine\Export\DEXIS`.
4. In Dental Machine, open a test patient and press **Open in …**. Check that the right patient opens.

Options, from a PowerShell window in the unzipped folder:
`.\install.ps1 -AllUsers` (the bridge runs for whoever signs in, for a shared operatory login) and
`.\install.ps1 -InstallDir D:\DentalMachine`.

To remove the bridge, run `C:\DentalMachine\uninstall.cmd`. It removes the task, the bridge and its settings.
Exported images are left where they are. Then remove the workstation in Settings so its key stops working.

**Why a logon task and not a Windows service?** A Windows service runs in a separate, invisible session. From
there it can't open DEXIS, Sidexis and the like on the operatory screen. A task that runs as the signed-in person
can, and Task Scheduler restarts it if it stops. `run-bridge.ps1` keeps the bridge running and writes its output
to `C:\DentalMachine\bridge.log`. The log is rolled over at 5 MB.

### On a Mac or Linux PC

Unzip the package, open Terminal in the folder, and run `sh install.sh`. It needs Node.js 18 or newer; on a Mac
with Homebrew it installs Node.js for you. The installer:

- copies the bridge to `~/DentalMachineBridge`.
- starts the bridge at sign-in: a LaunchAgent (`com.dentalmachine.bridge`) on macOS, or a systemd user service
  (`dental-machine-bridge`) on Linux.
- runs the setup check.

Export folders are `~/DentalMachineBridge/Export/<program>`. `sh install.sh --uninstall` removes the bridge.
Most presets are for Windows programs. On a Mac, fill in **Program path** for each program in the wizard.

## Presets

`bridge/presets.json` lists about 20 imaging programs:

- DEXIS and DEXIS 10/IS
- Sidexis 4
- CS Imaging 8 and Carestream RVG/Trophy
- Planmeca Romexis
- Apteryx XrayVision and XVWeb
- VixWin
- Schick CDR
- Dolphin
- MiPACS
- TigerView
- Patterson Imaging/Eaglesoft
- Dentrix Image
- Vatech EzDent-i
- Midmark Progeny
- Owandy QuickVision
- CliniView
- two "Other program" entries: patient number on the command line, or a patient INI file
- "Export folder only"

In `bridge-config.json` a preset is one line:

```json
"apps": [{ "preset": "dexis" }, { "preset": "eaglesoft", "command": "D:\\EagleSoft\\Shared Files\\PattersonImaging.exe" }]
```

Any field you add overrides the preset's value:

| Field | What it does |
| --- | --- |
| `command` | The program to start. |
| `args` | The command-line arguments. |
| `writeFile` | The bridge file: `{ "path", "content" }`. It's merged with the preset's. `false` turns it off. |
| `watch` | The export folders. `false` stops watching the preset's folder. |
| `name`, `id` | The name and id shown in the chart. |

Programs written out in full, as in older configs, still work unchanged. Placeholders:

| Placeholder | Filled in with |
| --- | --- |
| `{patientId}` | The patient's chart number |
| `{firstName}`, `{lastName}`, `{preferredName}` | The patient's name |
| `{dob}` | Date of birth as YYYY-MM-DD |
| `{dobYMD}` | Date of birth as YYYYMMDD |
| `{dobMDY}` | Date of birth as MM/DD/YYYY |
| `{dobDMY}` | Date of birth as DD/MM/YYYY |
| `{dobDotted}` | Date of birth as DD.MM.YYYY |
| `{gender}` | M, F or U |
| `{bridgeFile}` | The path of this program's bridge file |

The preset tells the program which patient to open in one of these ways (its `handoff`):

- **args**: the patient goes on the command line.
- **file**: the patient goes in a small bridge file that the program reads.
- **file+args**: both of the above.
- **none**: nothing is passed. The program opens and staff pick the patient in it.

**none** is used where the vendor's interface can't be driven from a command line:

- Sidexis 4 (its SLIDA mailbox file)
- Schick CDR (COM/OLE)
- QuickVision (Windows messages)
- XVWeb and Dentrix Image (no outside hand-off)

Exported images are still filed under the patient last opened from the chart on that PC.

### What is confirmed and what isn't

Each preset's `comment` says what is **Known** and what is **Assumed**. Most vendors don't publish their bridge
interfaces. Presets marked `"verify": true` use command-line switches and file formats from public PMS bridge
notes. They have **not** been tested against each vendor's current release. `--check` prints a `NOTE` line for
each of these, and the wizard shows **Check once after installing**. Test **Open in …** once per program. If the
wrong patient opens, or none does, correct `args` or `writeFile` in `bridge-config.json`. Your imaging vendor's
"practice management bridge" guide lists the right values. Then tell us, so the preset can be fixed.

Only the generic entries are unmarked: "Other program: patient number", "Other program: patient file (INI)" and
"Export folder only".

## For developers

The package route is in `server/src/routes/bridgepackage.js`. Mount it in the signed-in API router in `app.js`,
after `imagingRoutes`:

```js
import bridgePackageRoutes from './routes/bridgepackage.js';
api.use(bridgePackageRoutes({ db, config }));
```

The routes:

- `GET /api/imaging/presets` (clinical:read): the wizard's program list.
- `GET /api/imaging/presets-download`: `presets.json`, for setting a bridge up by hand.
- `POST /api/imaging/agents/:id/package` (admins only): the zip.

The package route takes `{ token, apps, sensor, platform, server }`. Its `token` must be the `dmb_` key that
`POST /imaging/agents` just returned: its hash must match the workstation's, and the workstation must be less than
30 minutes old. The server never stores the key, so it can't make a package later on its own. Every package is
audited as `bridge.package`, without the key. Refusals are audited as `bridge.package_refused`.

The zip is built by `server/src/zip.js`, a store-only writer with no dependencies. The installer scripts are
`bridge/installer/*`. The server converts the Windows scripts to CRLF line endings.
