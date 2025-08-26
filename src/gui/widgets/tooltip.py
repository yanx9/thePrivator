"""Custom tooltip widget for CustomTkinter."""

import customtkinter as ctk
import tkinter as tk


class ToolTip:
    """Creates a tooltip for a given widget."""

    def __init__(self, widget, text='', delay=500, wraplength=250):
        self.widget = widget
        self.delay = delay
        self.wraplength = wraplength
        self.tooltip = None
        self.id = None
        self.x = self.y = 0

        # Allow dynamic notes: text can be a string or a callable returning a string
        self._text_provider = text if callable(text) else (lambda: text)

        # Bind events
        self.widget.bind("<Enter>", self.on_enter, add="+")
        self.widget.bind("<Leave>", self.on_leave, add="+")
        self.widget.bind("<ButtonPress>", self.on_leave, add="+")  # hide on click

    def on_enter(self, event=None):
        """Handle mouse enter."""
        self.schedule()

    def on_leave(self, event=None):
        """Handle mouse leave."""
        self.unschedule()
        self.hide()

    def schedule(self):
        """Schedule tooltip display."""
        self.unschedule()
        self.id = self.widget.after(self.delay, self.show)

    def unschedule(self):
        """Cancel scheduled tooltip."""
        id_ = self.id
        self.id = None
        if id_:
            self.widget.after_cancel(id_)

    def show(self):
        """Display the tooltip near the mouse pointer with transparent corners."""
        # Get the latest text just before showing (supports dynamic updates)
        text = self._text_provider() if callable(self._text_provider) else self._text_provider
        if not text:
            return

        # Position near mouse pointer so it doesn't overlap the hover source
        x = self.widget.winfo_pointerx() + 16
        y = self.widget.winfo_pointery() + 18

        # Create tooltip window
        self.tooltip = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        try:
            tw.wm_attributes("-topmost", True)
        except Exception:
            pass

        # Use a key color for window background and mark it transparent (if supported)
        TRANSPARENT_KEY = "#010203"
        try:
            tw.configure(bg=TRANSPARENT_KEY)
            tw.wm_attributes("-transparentcolor", TRANSPARENT_KEY)
            bg_for_label = TRANSPARENT_KEY
        except Exception:
            # Fallback when -transparentcolor isn't supported; still works without hard edges
            bg_for_label = "transparent"

        # Style the tooltip bubble
        label = ctk.CTkLabel(
            tw,
            text=text,
            justify="left",
            wraplength=self.wraplength,
            fg_color=("gray85", "gray20"),
            corner_radius=8,
            text_color=("gray10", "gray90"),
            font=ctk.CTkFont(size=11),
            bg_color=bg_for_label,
        )
        label.pack(ipadx=8, ipady=6)

        # Position tooltip window
        tw.wm_geometry(f"+{x}+{y}")

    def hide(self):
        """Hide the tooltip."""
        tw = self.tooltip
        self.tooltip = None
        if tw:
            tw.destroy()

    def update_text(self, text):
        """Accept either a string or a callable returning the tooltip text."""
        self._text_provider = text if callable(text) else (lambda: text)
