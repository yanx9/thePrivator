from typing import Optional, Tuple, Union
import customtkinter
from core import Core
class App(customtkinter.CTk):
    
    def __init__(self):
        core = Core()
        # print(core.loaded_profiles)
        super().__init__()
        self.geometry(f"{1100}x{700}")
        self.title("thePrivator")
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(10, weight=1)

        self.top_frame = customtkinter.CTkFrame(self, height=40)
        self.top_frame.grid(row=0, column=0, padx=10, pady=(10, 0), sticky="new")
        self.searchBar = customtkinter.CTkEntry(self.top_frame, height=30, placeholder_text="Search", border_width=0)
        self.searchBar.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.createButton = customtkinter.CTkButton(self.top_frame, width=30, height=30, text="+")
        self.createButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="w")
        self.profile_frames = {}
        self.start_buttons = []
        for i, profile, in enumerate(core.loaded_profiles()):
            self.profile_frames.append(customtkinter.CTkFrame(self, height=50))
            self.profile_frames[profile.name].grid(row=i+1, column=0, padx=10, pady=(10, 0), sticky="new")

            button = customtkinter.CTkButton(self.profile_frames[i], width=30, height=30, text="▶️")
            button.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="w")

            self.start_buttons.append(button)

    def update_list(self):
        pass

if __name__ == "__main__":
    app = App()
    app.mainloop()