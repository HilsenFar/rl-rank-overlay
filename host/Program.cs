using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Forms = System.Windows.Forms;

namespace RLOverlay
{
    // A single transparent, always-on-top window that shows the overlay page.
    //
    // Why a native host at all: a plain browser window can't be transparent over
    // a game. Here WPF's own surface is painted transparent and the DWM frame is
    // stretched across the whole client area, so everything the page does NOT
    // draw is the screen (the game) behind it. The window still takes mouse
    // clicks — needed so the drag grip works — but never steals focus from the
    // game (WS_EX_NOACTIVATE) and can be made fully click-through on request.
    //
    // The window belongs to the game: when Rocket League isn't running it hides
    // itself, and comes back when the game starts. It shows the SAME page the
    // local server serves at http://localhost:8342/ .
    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref Margins m);

        [StructLayout(LayoutKind.Sequential)]
        private struct Margins { public int Left, Right, Top, Bottom; }

        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 2;
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TRANSPARENT = 0x00000020; // clicks pass through to the game
        private const int WS_EX_NOACTIVATE = 0x08000000;  // must never take focus from the game
        private const int WS_EX_TOOLWINDOW = 0x00000080;  // no alt-tab entry

        private static Window _win;
        private static WebView2 _web;
        private static Forms.NotifyIcon _tray;
        private static DispatcherTimer _retryTimer;
        private static string _dir, _cfg;
        private static string _url = "http://localhost:8342/";
        private static bool _clickThrough;
        private static bool _sized, _hasPos, _isShown, _wantShown = true, _gameOn = true;
        private static double _anchorX = double.NaN, _anchorY = double.NaN;
        private static int _sentAvail = -1;

        [STAThread]
        private static int Main(string[] args)
        {
            using (new Mutex(true, "Local\\RL-Rank-Overlay", out bool mine))
            {
                if (!mine) return 0;
                try { Run(args); }
                catch (Exception ex)
                {
                    Forms.MessageBox.Show("The overlay could not start:\n\n" + ex.Message,
                        "RL Rank Overlay", Forms.MessageBoxButtons.OK, Forms.MessageBoxIcon.Error);
                    return 1;
                }
            }
            return 0;
        }

        private static void Run(string[] args)
        {
            _dir = AppDomain.CurrentDomain.BaseDirectory;
            _cfg = Path.Combine(_dir, "overlay-window.json");
            ReadArgs(args);
            ReadConfig();
            StartReader();

            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            CreateWindow();
            StartGameWatch();
            BuildTray();
            app.Run();
            if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
            StopReader();
        }

        // ---- the local reader (Node) ----
        // Double-clicking this exe is all a user should ever need: if the
        // release layout is next to us (node\node.exe + src\overlay.mjs) and
        // nothing already answers on the local port, start the reader
        // ourselves, hidden, and take it down again when the overlay quits.
        // The WebView's retry loop covers the second or two until it listens.
        private static Process _node;

        private static bool PortOpen(int port)
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var t = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!t.AsyncWaitHandle.WaitOne(250)) return false;
                    c.EndConnect(t);
                    return true;
                }
            }
            catch { return false; }
        }

        private static void StartReader()
        {
            string node = Path.Combine(_dir, "node", "node.exe");
            string script = Path.Combine(_dir, "src", "overlay.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return;   // source checkout: run node yourself
            if (PortOpen(8342)) return;                               // a reader is already up
            try
            {
                _node = Process.Start(new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + script + "\"",
                    WorkingDirectory = _dir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch { _node = null; }                                   // overlay still works against an external reader
        }

        private static void StopReader()
        {
            try { if (_node != null && !_node.HasExited) _node.Kill(); }
            catch { }
        }

        private static void ReadArgs(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i].TrimStart('-', '/').ToLowerInvariant();
                string v = i + 1 < args.Length ? args[i + 1] : null;
                if (a == "url" && v != null) { _url = v; i++; }
                else if (a == "clickthrough") _clickThrough = true;
            }
        }

        private static void CreateWindow()
        {
            _win = new Window
            {
                Title = "RL Rank Overlay",
                WindowStyle = WindowStyle.None,
                AllowsTransparency = false,     // deliberate — see class comment
                Background = Brushes.Transparent,
                Topmost = true,
                ShowInTaskbar = false,
                ShowActivated = false,
                ResizeMode = ResizeMode.NoResize,
                WindowStartupLocation = WindowStartupLocation.Manual,
                Width = 640,
                Height = 120
            };
            PlaceAtStart();

            _web = new WebView2 { DefaultBackgroundColor = System.Drawing.Color.Transparent };
            _win.Content = _web;
            _win.SourceInitialized += (s, e) => ApplyStyles();
            _win.Loaded += async (s, e) => await StartWeb();
            _win.Show();
            _isShown = true;
        }

        private static void PlaceAtStart()
        {
            var wa = SystemParameters.WorkArea;
            if (double.IsNaN(_anchorX) || double.IsNaN(_anchorY))
            {
                _anchorX = wa.Left + (wa.Width - _win.Width) / 2;
                _anchorY = wa.Bottom - _win.Height - 24;
            }
            _win.Left = _anchorX;
            _win.Top = _anchorY;
        }

        private static void ApplyStyles()
        {
            IntPtr h = new WindowInteropHelper(_win).Handle;
            if (h == IntPtr.Zero) return;
            int ex = GetWindowLong(h, GWL_EXSTYLE) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            if (_clickThrough) ex |= WS_EX_TRANSPARENT; else ex &= ~WS_EX_TRANSPARENT;
            SetWindowLong(h, GWL_EXSTYLE, ex);
            try
            {
                var src = HwndSource.FromHwnd(h);
                if (src != null && src.CompositionTarget != null)
                    src.CompositionTarget.BackgroundColor = Colors.Transparent;
                var m = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
                DwmExtendFrameIntoClientArea(h, ref m);
            }
            catch { }
        }

        private static async System.Threading.Tasks.Task StartWeb()
        {
            string udf = Path.Combine(_dir, "overlay-webview");
            try { Directory.CreateDirectory(udf); } catch { }
            var env = await CoreWebView2Environment.CreateAsync(null, udf);
            await _web.EnsureCoreWebView2Async(env);

            var c = _web.CoreWebView2;
            c.Settings.AreDefaultContextMenusEnabled = false;
            c.Settings.AreDevToolsEnabled = false;
            c.Settings.IsStatusBarEnabled = false;
            c.Settings.IsZoomControlEnabled = false;
            c.Settings.AreBrowserAcceleratorKeysEnabled = false;
            c.WebMessageReceived += OnWebMessage;
            c.NavigationCompleted += (s, e) => { if (!e.IsSuccess) ScheduleRetry(); };
            c.Navigate(_url);
        }

        private static void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; }
            if (string.IsNullOrEmpty(msg)) return;

            if (msg == "drag")
            {
                IntPtr h = new WindowInteropHelper(_win).Handle;
                ReleaseCapture();
                SendMessage(h, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                _anchorX = _win.Left; _anchorY = _win.Top;
                Save();
                return;
            }
            if (msg == "empty") { SetWantShown(false); return; }
            if (!msg.StartsWith("size:", StringComparison.Ordinal)) return;

            string[] p = msg.Substring(5).Split(',');
            if (p.Length != 2) return;
            if (!double.TryParse(p[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double w)) return;
            if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double hgt)) return;
            if (w < 40 || hgt < 10 || w > 8000 || hgt > 2000) return;

            Rect wa = WorkArea();
            if (w > wa.Width) w = wa.Width;
            if (hgt > wa.Height) hgt = wa.Height;
            if (Math.Abs(_win.Width - w) > 0.5) _win.Width = w;
            if (Math.Abs(_win.Height - hgt) > 0.5) _win.Height = hgt;

            if (!_sized && !_hasPos)
            {
                _anchorX = wa.Left + (wa.Width - _win.Width) / 2;
                _anchorY = wa.Bottom - _win.Height - 24;
            }
            _sized = true;
            SendAvailWidth(wa);
            Reposition(wa);
            SetWantShown(true);
        }

        // ---- visibility: the overlay belongs to the game ----
        private static void StartGameWatch()
        {
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            t.Tick += (s, e) => CheckGame();
            t.Start();
            CheckGame();
        }
        private static void CheckGame()
        {
            bool on;
            try { on = Process.GetProcessesByName("RocketLeague").Length > 0; }
            catch { on = true; }
            SetGameRunning(on);
        }
        private static void SetGameRunning(bool on) { if (_gameOn != on) { _gameOn = on; UpdateVisibility(); } }
        private static void SetWantShown(bool want) { if (_wantShown != want) { _wantShown = want; UpdateVisibility(); } }
        private static void UpdateVisibility()
        {
            bool want = _gameOn && _wantShown;
            if (want == _isShown) return;
            if (want) { _win.Show(); _isShown = true; ApplyStyles(); }
            else { _win.Hide(); _isShown = false; }
        }

        private static void SendAvailWidth(Rect wa)
        {
            if (_web == null || _web.CoreWebView2 == null) return;
            double ax = double.IsNaN(_anchorX) ? wa.Left : _anchorX;
            int avail = (int)Math.Max(320, wa.Right - ax - 4);
            if (avail == _sentAvail) return;
            _sentAvail = avail;
            try { _web.CoreWebView2.PostWebMessageAsString("max:" + avail.ToString(CultureInfo.InvariantCulture)); }
            catch { }
        }

        private static void Reposition(Rect wa)
        {
            if (double.IsNaN(_anchorX) || double.IsNaN(_anchorY)) return;
            _win.Left = Math.Max(wa.Left, Math.Min(_anchorX, wa.Right - _win.Width));
            _win.Top = Math.Max(wa.Top, Math.Min(_anchorY, wa.Bottom - _win.Height));
        }

        private static Rect WorkArea()
        {
            var scr = Forms.Screen.FromHandle(new WindowInteropHelper(_win).Handle).Bounds;
            var src = PresentationSource.FromVisual(_win);
            if (src == null || src.CompositionTarget == null)
                return new Rect(scr.Left, scr.Top, scr.Width, scr.Height);
            var m = src.CompositionTarget.TransformFromDevice;
            Point tl = m.Transform(new Point(scr.Left, scr.Top));
            Point br = m.Transform(new Point(scr.Right, scr.Bottom));
            return new Rect(tl, br);
        }

        private static void ScheduleRetry()
        {
            if (_retryTimer == null)
            {
                _retryTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
                _retryTimer.Tick += (s, e) =>
                {
                    _retryTimer.Stop();
                    if (_web != null && _web.CoreWebView2 != null) _web.CoreWebView2.Navigate(_url);
                };
            }
            _retryTimer.Stop();
            _retryTimer.Start();
        }

        // ---- tray + saved position ----
        private static void BuildTray()
        {
            _tray = new Forms.NotifyIcon { Visible = true, Text = "RL Rank Overlay" };
            string ico = Path.Combine(_dir, "icon.ico");
            try { _tray.Icon = File.Exists(ico) ? new System.Drawing.Icon(ico) : System.Drawing.SystemIcons.Application; }
            catch { _tray.Icon = System.Drawing.SystemIcons.Application; }

            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add(new Forms.ToolStripMenuItem("Drag the card by its grip to move it") { Enabled = false });
            menu.Items.Add(new Forms.ToolStripSeparator());
            var ct = new Forms.ToolStripMenuItem("Click-through") { CheckOnClick = true, Checked = _clickThrough };
            ct.CheckedChanged += (s, e) => { _clickThrough = ct.Checked; ApplyStyles(); Save(); };
            menu.Items.Add(ct);
            menu.Items.Add("Reload", null, (s, e) => { if (_web?.CoreWebView2 != null) _web.CoreWebView2.Reload(); });
            menu.Items.Add("Reset position", null, (s, e) => { _hasPos = false; _sized = false; _anchorX = double.NaN; _anchorY = double.NaN; PlaceAtStart(); Save(); });
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("Quit overlay", null, (s, e) => Application.Current.Shutdown());
            _tray.ContextMenuStrip = menu;
        }

        private static void ReadConfig()
        {
            try
            {
                if (!File.Exists(_cfg)) return;
                string j = File.ReadAllText(_cfg);
                _anchorX = JsonNum(j, "x", _anchorX);
                _anchorY = JsonNum(j, "y", _anchorY);
                if (j.IndexOf("\"clickThrough\":true", StringComparison.OrdinalIgnoreCase) >= 0) _clickThrough = true;
                _hasPos = !double.IsNaN(_anchorX) && !double.IsNaN(_anchorY);
            }
            catch { }
        }

        private static double JsonNum(string json, string key, double fallback)
        {
            var m = System.Text.RegularExpressions.Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?[0-9.]+)");
            if (!m.Success) return fallback;
            return double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out double d) ? d : fallback;
        }

        private static void Save()
        {
            try
            {
                if (_win == null) return;
                double ax = double.IsNaN(_anchorX) ? _win.Left : _anchorX;
                double ay = double.IsNaN(_anchorY) ? _win.Top : _anchorY;
                string j = "{\"x\":" + Math.Round(ax).ToString(CultureInfo.InvariantCulture)
                         + ",\"y\":" + Math.Round(ay).ToString(CultureInfo.InvariantCulture)
                         + ",\"clickThrough\":" + (_clickThrough ? "true" : "false") + "}";
                File.WriteAllText(_cfg, j);
            }
            catch { }
        }
    }
}
