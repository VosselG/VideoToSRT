import os
import fnmatch

def parse_ignore_file(ignore_file):
    """
    Parses the ignore file to extract all rule types and the operating mode.
    """
    mode = 'default' # default, folders_only, ignore_all
    full_ignore = ['generate_tree.py', 'directory_tree.txt', ignore_file]
    content_ignore = []
    inclusions = []

    if not os.path.exists(ignore_file):
        return mode, full_ignore, content_ignore, inclusions
    
    with open(ignore_file, 'r') as f:
        for line in f:
            pattern = line.strip()
            if not pattern or pattern.startswith('#'):
                continue
            
            if pattern == '**':
                mode = 'ignore_all'
            elif pattern == '*':
                mode = 'folders_only'
            elif pattern.startswith('^'):
                inclusions.append(pattern[1:])
            elif pattern.endswith('/'):
                content_ignore.append(pattern[:-1])
            else:
                full_ignore.append(pattern)
                
    return mode, full_ignore, content_ignore, inclusions

def is_match(name, patterns):
    """Checks if a name matches any of the glob patterns."""
    return any(fnmatch.fnmatch(name, pattern) for pattern in patterns)

def count_contents(path, full_ignore_patterns):
    """Counts non-ignored items in a directory for the summary."""
    try:
        items = os.listdir(path)
        non_ignored_items = [item for item in items if not is_match(item, full_ignore_patterns)]
        dir_count = sum(1 for item in non_ignored_items if os.path.isdir(os.path.join(path, item)))
        file_count = len(non_ignored_items) - dir_count
        return dir_count, file_count
    except OSError:
        return 0, 0

def generate_tree(startpath, output_file, mode, full_ignore, content_ignore, inclusions):
    """Generates the directory tree using the parsed rules."""
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(f"{os.path.basename(startpath)}/\n")
        _walk_directory(startpath, "", f, mode, full_ignore, content_ignore, inclusions, False)

def _walk_directory(path, prefix, file_obj, mode, full_ignore, content_ignore, inclusions, is_in_included_subtree):
    """Recursively walks the directory to build the tree structure."""
    try:
        all_items = sorted(os.listdir(path), key=lambda s: s.lower())
    except OSError:
        return

    items_to_process = []
    for item_name in all_items:
        # Rule 1: Highest priority - check for full ignore.
        if is_match(item_name, full_ignore):
            continue

        is_explicitly_included = is_match(item_name, inclusions)
        
        # Determine if the item should be kept based on the mode and rules
        should_keep = False
        if is_in_included_subtree or is_explicitly_included:
            should_keep = True
        elif mode == 'default':
            should_keep = True
        elif mode == 'folders_only' and os.path.isdir(os.path.join(path, item_name)):
            should_keep = True
        
        if should_keep:
            items_to_process.append((item_name, is_explicitly_included))

    for i, (item_name, is_explicitly_included) in enumerate(items_to_process):
        is_last = i == (len(items_to_process) - 1)
        connector = "└── " if is_last else "├── "
        item_path = os.path.join(path, item_name)
        
        if os.path.isdir(item_path):
            # If a folder is included, all its children should be treated as included
            new_is_in_included_subtree = is_in_included_subtree or is_explicitly_included

            if is_match(item_name, content_ignore):
                dir_count, file_count = count_contents(item_path, full_ignore)
                summary = f" [... {dir_count} folders, {file_count} files]"
                file_obj.write(f"{prefix}{connector}{item_name}/{summary}\n")
            else:
                file_obj.write(f"{prefix}{connector}{item_name}/\n")
                new_prefix = prefix + ("    " if is_last else "│   ")
                _walk_directory(item_path, new_prefix, file_obj, mode, full_ignore, content_ignore, inclusions, new_is_in_included_subtree)
        else: # It's a file
            file_obj.write(f"{prefix}{connector}{item_name}\n")

if __name__ == '__main__':
    current_directory = os.getcwd()
    output_filename = 'directory_tree.txt'
    ignore_filename = 'ignore.txt'
    
    mode, full_patterns, content_patterns, inclusion_patterns = parse_ignore_file(ignore_filename)
    
    print("--- Tree Generator Settings ---")
    print(f"Mode: {mode.replace('_', ' ').title()}")
    print(f"Inclusion Patterns: {inclusion_patterns}")
    print(f"Full Ignore Patterns: {full_patterns}")
    print(f"Content Summary Patterns: {content_patterns}")
    
    generate_tree(current_directory, output_filename, mode, full_patterns, content_patterns, inclusion_patterns)
    
    print(f"\nDirectory tree saved to '{output_filename}'")