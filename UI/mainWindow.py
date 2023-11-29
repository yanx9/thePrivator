import tkinter as tk
from typing import Optional, Tuple, Union
import customtkinter as ctk


class mainWindow(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.geometry(f"{1100}x{700}")
        self.title("thePrivator")
        self.grid_columnconfigure(0, weight=1)
        self.top_frame = ctk.CTkFrame(self, height=40)
        self.top_frame.grid(row=0, column=0, padx=10, pady=(10, 0), sticky="new")
        self.searchBar = ctk.CTkEntry(self.top_frame, height=30, placeholder_text="Search", border_width=0)
        self.searchBar.grid(row=0, column=0, padx=10, pady=(10, 10))
        self.createButton = ctk.CTkButton(self.top_frame, width=30, height=30, text="+")
        self.createButton.grid(row=0, column=1, padx=10, pady=(10, 10))
        self.profile_frames = {}
        self.start_buttons = {}