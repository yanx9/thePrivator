import customtkinter as ctk
from core import Core
from copy import copy
class Settings(ctk.CTkToplevel):
    def __init__(self, *args, **kwargs):
        self.core = Core()
        super().__init__(*args, **kwargs)
        self.geometry("400x180")
        self.grid_columnconfigure(0, weight=1)

        self.settings = self.core.get_settings()
        self.mainFrame = ctk.CTkFrame(self, width=300, height=120)
        self.mainFrame.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="new")
        self.mainFrame.rowconfigure(0, weight=1)
        self.mainFrame.rowconfigure(0, weight=1)

        self.chromiumPathFrame = ctk.CTkFrame(self.mainFrame, height=50)
        self.chromiumPathFrame.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="new")
        self.chromiumPathLabel = ctk.CTkLabel(self.chromiumPathFrame, text="Chromium path: ")
        self.chromiumPathLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.chromiumPathEntry = ctk.CTkEntry(self.chromiumPathFrame, width=220)
        self.chromiumPathEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.chromiumPathEntry.insert(ctk.END, self.settings["chromiumPath"])
        self.chromiumPathFrame.columnconfigure(0, weight=1)

        self.changesFrame = ctk.CTkFrame(self, height=50)
        self.changesFrame.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="sew")
        self.saveButton = ctk.CTkButton(self.changesFrame, text="Save Changes", command=self.save_changes_callback)
        self.saveButton.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nwse")
        self.discardButton = ctk.CTkButton(self.changesFrame, text="Discard Changes", command=self.discard_changes_callback)
        self.discardButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="nwse")
        self.changesFrame.columnconfigure(0, weight=1)
        self.changesFrame.columnconfigure(1, weight=1)

    def save_changes_callback(self):
        result = copy(self.settings)
        result.update(
            {
                "chromiumPath": self.chromiumPathEntry.get()
            }
                      )
        self.core.set_settings(result)
        self.destroy()

    def discard_changes_callback(self):
        self.destroy()