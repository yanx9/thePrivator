from typing import Optional, Tuple, Union
import customtkinter as ctk
from core import Core
from Model.Profile import Profile

class App(ctk.CTk):
    
    def __init__(self):
        self.core = Core()
        # print(core.loaded_profiles)
        super().__init__()
        self.geometry(f"{1100}x{700}")
        self.title("thePrivator")
        self.grid_columnconfigure(0, weight=1)
     #   self.grid_rowconfigure(10, weight=1)

        self.top_frame = ctk.CTkFrame(self, height=40)
        self.top_frame.grid(row=0, column=0, padx=10, pady=(10, 0), sticky="new")
        self.searchBar = ctk.CTkEntry(self.top_frame, height=30, placeholder_text="Search", border_width=0)
        self.searchBar.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.createButton = ctk.CTkButton(self.top_frame, width=30, height=30, text="+")
        self.createButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="w")
        self.profile_frames = {}
        self.start_buttons = {}
        for i, profile in enumerate(self.core.loaded_profiles):
            self.profile_frames.update({profile.name: ctk.CTkFrame(self, height=50)})
            self.profile_frames[profile.name].grid(row=i+1, column=0, padx=10, pady=(10, 0), sticky="new")
            
            label = ctk.CTkLabel(self.profile_frames[profile.name], text=profile.name)
            label.grid(row=0, column=0, padx=10, pady=(10, 10))
            button = ctk.CTkButton(self.profile_frames[profile.name],
                                              fg_color='green', width=30, height=30, text="▶️",
                                                command=lambda arg=profile: self.run_profile_callback(arg))
            button.grid(row=0, column=1, padx=10, pady=(10, 10))

            self.start_buttons.update({profile.name: button})
        print(self.start_buttons)


    def update_list(self):
        pass

    def run_profile_callback(self, profile:Profile):
        self.start_buttons[profile.name].configure(state=ctk.DISABLED)
        self.core.run_profile(profile)
        self.start_buttons[profile.name].configure(state=ctk.NORMAL, fg_color='red', text="⏹️",
                                                    command=lambda arg=profile: self.stop_profile_callback(arg))
    def stop_profile_callback(self, profile:Profile):
        self.start_buttons[profile.name].configure(state=ctk.DISABLED)
        self.core.stop_profile(profile)
        self.start_buttons[profile.name].configure(state=ctk.NORMAL, fg_color='green', text="▶️",
                                                    command=lambda arg=profile: self.run_profile_callback(arg))

if __name__ == "__main__":
    app = App()
    app.mainloop()