import os
import random


def get_folder_size(folder_path) -> str:
    total_size = 0

    for dirpath, dirnames, filenames in os.walk(folder_path):
        for filename in filenames:
            filepath = os.path.join(dirpath, filename)
            try:
                total_size += os.path.getsize(filepath)
            except(FileNotFoundError):
                continue
    scale = "B"
    if total_size < 1024:
        return f"{total_size} B"
    elif total_size < 1048576:
        return f"{round(total_size/1024)} kB"
    else:
        return f"{round(total_size/1048576)} MB"

def get_random_ua(project_dir) -> str:
    try:
        file_path = f"{project_dir}/Data/user_agent.txt"
        with open(file_path, 'r') as file:
            lines = file.readlines()
            return random.choice(lines).strip()
    except FileNotFoundError:
        return "File not found!"
    except Exception as e:
        return f"Error: {e}"