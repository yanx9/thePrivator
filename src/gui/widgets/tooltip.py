"""Custom tooltip widget for CustomTkinter."""

import customtkinter as ctk
import tkinter as tk


class ToolTip:
    """Creates a tooltip for a given widget."""
    
    def __init__(self, widget, text='', delay=500, wraplength=250):
        self.widget = widget
        self.text = text
        self.delay = delay
        self.wraplength = wraplength
        self.tooltip = None
        self.id = None
        self.x = self.y = 0
        
        # Bind events
        self.widget.bind("<Enter>", self.on_enter, add="+")
        self.widget.bind("<Leave>", self.on_leave, add="+")
        self.widget.bind("<ButtonPress>", self.on_leave, add="+")
        
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
        """Display the tooltip."""
        if not self.text:
            return
            
        x, y, cx, cy = self.widget.bbox("insert") if hasattr(self.widget, 'bbox') else (0, 0, 0, 0)
        x += self.widget.winfo_rootx() + 25
        y += self.widget.winfo_rooty() + 25
        
        # Create tooltip window
        self.tooltip = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        
        # Style the tooltip
        label = ctk.CTkLabel(
            tw,
            text=self.text,
            justify="left",
            wraplength=self.wraplength,
            fg_color=("gray85", "gray20"),
            corner_radius=6,
            text_color=("gray10", "gray90"),
            font=ctk.CTkFont(size=11),
            bg_color=("transparent","transparent")
        )
        label.pack(ipadx=8, ipady=6)
        
        # Position tooltip
        tw.wm_geometry(f"+{x}+{y}")
        
    def hide(self):
        """Hide the tooltip."""
        tw = self.tooltip
        self.tooltip = None
        if tw:
            tw.destroy()
            
    def update_text(self, text):
        """Update tooltip text."""
        self.text = text